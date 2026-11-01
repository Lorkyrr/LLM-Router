import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Adapter, AdapterName } from "./adapters/types.ts";
import { availability, checkModels } from "./catalog/check.ts";
import { relay, type Transport } from "./channel/relay.ts";
import { TIERS, type Config } from "./config.ts";
import type { Exec } from "./exec.ts";
import { plan, storeItems } from "./planner/planner.ts";
import { decompose } from "./triage/decompose.ts";
import { strongBaseline } from "./policy/cost.ts";
import { selectModel } from "./policy/select.ts";
import { selectForStep } from "./planner/selection.ts";
import { dispatchRelease, syncReleased } from "./runner/release.ts";
import { runPlan } from "./runner/run-plan.ts";
import type { Lease } from "./runner/lease.ts";
import type { Runner, Repo } from "./store/repo.ts";
import { triage } from "./triage/triage.ts";

export type Ctx = {
  cfg: Config;
  adapters: Record<AdapterName, Adapter>;
  repo: Repo;
  exec: Exec;
  repoDir: string;
  base: string;
  runner: Runner;
  transport: Transport;
  lease?: Lease;
};

const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

// Erros de negócio (tarefa inexistente, modelo falhou) voltam como isError em vez de derrubar a conexão MCP.
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return reply(await fn(args));
    } catch (e) {
      return failure(e instanceof Error ? e.message : String(e));
    }
  };
}

export function makeServer(ctx: Ctx): McpServer {
  const { cfg, repo } = ctx;
  const server = new McpServer({ name: "llm-router", version: "0.1.0" });
  const stepDeps = { cfg, adapters: ctx.adapters, repo, exec: ctx.exec, repoDir: ctx.repoDir, base: ctx.base, runner: ctx.runner, lease: ctx.lease };
  const mustTask = (id: string) => {
    const t = repo.getTask(id);
    if (!t) throw new Error(`unknown task ${id}`);
    return t;
  };
  const describeSteps = (steps: ReturnType<Repo["listSteps"]>) => {
    const seqOf = new Map(steps.map((s) => [s.id, s.seq]));
    return steps.map((s) => {
      const phase = s.phase ?? (s.tier === "cheap" ? "simple_edit" : s.tier === "mid" ? "implementing" : "planning");
      const selection = selectForStep(cfg, s, availability(repo));
      const model = selection?.model ?? null;
      return { seq: s.seq, brief: s.brief, phase, role: s.role ?? phase, tier: s.tier, effort: s.effort ?? cfg.phases[phase].effort,
        model, adapter: model ? cfg.models[model]!.adapter : null,
        reason: s.reason ?? `Fase ${phase}; preferência configurada na categoria ${s.tier}`,
        depends_on: s.depends_on.map((id) => seqOf.get(id)), files: s.files };
    });
  };

  server.registerTool(
    "route",
    { description: "Classify a request and pick tier, model and effort.", inputSchema: { request: z.string().min(1), override_tier: z.enum(TIERS).nullish() } },
    tool(async ({ request, override_tier }) => {
      const items = await decompose(cfg, ctx.adapters, request, { cwd: ctx.repoDir, repo });
      if (items) {
        if (override_tier) for (const item of items) {
          item.tier = override_tier;
          item.effort = cfg.escalation.ladder[override_tier][0]!.effort;
          item.reason += `; categoria sobrescrita pelo usuário: ${override_tier}`;
        }
        const task = repo.insertTask({ request });
        const subtasks = describeSteps(storeItems(repo, task.id, items));
        const waiting = subtasks.some((s) => !s.model);
        if (waiting) repo.updateTask(task.id, { status: "waiting_quota" });
        return { task_id: task.id, subtasks, next: waiting ? "wait" : "run" };
      }
      const t = await triage(cfg, ctx.adapters, request, { cwd: ctx.repoDir, repo, overrideTier: override_tier ?? undefined });
      const task = repo.insertTask({ request, phase: t.phase, tier: t.tier });
      const name = selectModel(cfg, t.tier, availability(repo), t.phase);
      if (!name) repo.updateTask(task.id, { status: "waiting_quota" });
      // cheap/mid não passam pelo planner: este passo único é o que run_plan executa.
      else if (t.tier !== "strong") repo.insertStep({ task_id: task.id, seq: 1, brief: request, tier: t.tier, phase: t.phase, effort: t.effort, depends_on: [], files: [] });
      const model = name ? cfg.models[name] : undefined;
      return {
        task_id: task.id, phase: t.phase, tier: t.tier, model: name, adapter: model?.adapter ?? null, effort: t.effort,
        ...(model?.guidance ? { guidance: model.guidance } : {}),
        ...(model?.pricing ? { pricing: model.pricing } : {}),
        subtasks: [{ seq: 1, brief: request, ...t, model: name, reason: `Fase ${t.phase}; preferência configurada na categoria ${t.tier}`, depends_on: [], files: [] }],
        next: !name ? "wait" : t.tier === "strong" ? "plan" : "run",
      };
    }),
  );

  server.registerTool(
    "plan",
    { description: "Decompose with heuristics or cheap/low and route each step independently.", inputSchema: { task_id: z.string() } },
    tool(async ({ task_id }) => {
      mustTask(task_id);
      const steps = await plan(cfg, ctx.adapters, repo, task_id, { cwd: ctx.repoDir });
      return {
        steps: describeSteps(steps),
      };
    }),
  );

  server.registerTool(
    "run_plan",
    { description: "Start executing the steps of a task; returns at once.", inputSchema: { task_id: z.string() } },
    tool(async ({ task_id }) => {
      mustTask(task_id);
      const steps = repo.listSteps(task_id);
      if (steps.length === 0) throw new Error(`task ${task_id} has no steps: call plan first`);
      // Sem await: um plano leva minutos e o cliente MCP acompanha por `status`.
      runPlan(stepDeps, task_id).catch((e) => console.error(`run_plan ${task_id}:`, e));
      return {
        started: steps.filter((s) => s.depends_on.length === 0).map((s) => s.seq),
        waiting: steps.filter((s) => s.depends_on.length > 0).map((s) => s.seq),
      };
    }),
  );

  server.registerTool(
    "release",
    {
      description: "Signal that the open router PRs (staged mode) may be compared, CI-tested, merged and their branches deleted by the GitHub workflow. sync_only just refreshes local state from GitHub.",
      inputSchema: { sync_only: z.boolean().nullish() },
    },
    tool(async ({ sync_only }) => {
      const d = { exec: ctx.exec, repo, repoDir: ctx.repoDir, base: ctx.base, lease: ctx.lease };
      if (sync_only) return await syncReleased(d);
      const { prs, done } = await dispatchRelease(d);
      // Sem await: o workflow leva minutos; `status` e `release {sync_only}` mostram o resultado.
      done.catch((e) => console.error("release:", e));
      return { dispatched: prs, next: "status" };
    }),
  );

  server.registerTool(
    "status",
    { description: "Tasks, steps, attempts and cost per tier.", inputSchema: { task_id: z.string().nullish() } },
    tool(async ({ task_id }) => {
      const usage = repo.usageByTier();
      const all = Object.values(usage);
      const sum = (k: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens") => all.reduce((a, u) => a + u[k], 0);
      const cost = {
        by_tier: usage,
        all_strong_baseline_usd: strongBaseline(cfg, {
          input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"),
          cache_read_tokens: sum("cache_read_tokens"), cache_write_tokens: sum("cache_write_tokens"),
        }),
        actual_usd: all.reduce((a, u) => a + u.est_cost_usd, 0),
        // actual_usd é alias legado: esta soma mistura valores do CLI e estimativas.
        recorded_or_estimated_usd: all.reduce((a, u) => a + u.est_cost_usd, 0),
        billing_verified: false,
      };
      if (!task_id) return { cost };
      const task = mustTask(task_id);
      return { task, steps: repo.listSteps(task_id).map((s) => ({ ...s, attempts: repo.listAttempts(s.id) })), cost };
    }),
  );

  server.registerTool(
    "check_models",
    { description: "Ping every model and record availability. Costs a few tokens per model.", inputSchema: {} },
    tool(async () => {
      await checkModels(cfg, ctx.adapters, repo);
      return repo.listModels().map((m) => ({ name: m.name, tier: m.tier, available: m.available, quota_state: m.quota_state, checked_at: m.checked_at }));
    }),
  );

  server.registerTool(
    "relay",
    { description: "Send a message to the grok bot; falls back to Claude when it is offline.", inputSchema: { body: z.string().min(1), task_id: z.string().nullish() } },
    tool(({ body, task_id }) => relay(repo, ctx.transport, { body, task_id: task_id ?? undefined })),
  );

  return server;
}
