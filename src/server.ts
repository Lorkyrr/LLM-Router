import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Adapter, AdapterName } from "./adapters/types.ts";
import { availability, checkModels } from "./catalog/check.ts";
import { relay, type Transport } from "./channel/relay.ts";
import { TIERS, type Config } from "./config.ts";
import type { Exec } from "./exec.ts";
import { plan } from "./planner/planner.ts";
import { strongBaseline } from "./policy/cost.ts";
import { selectModel } from "./policy/select.ts";
import { runPlan } from "./runner/run-plan.ts";
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
  const stepDeps = { cfg, adapters: ctx.adapters, repo, exec: ctx.exec, repoDir: ctx.repoDir, base: ctx.base, runner: ctx.runner };
  const mustTask = (id: string) => {
    const t = repo.getTask(id);
    if (!t) throw new Error(`unknown task ${id}`);
    return t;
  };

  server.registerTool(
    "route",
    { description: "Classify a request and pick tier, model and effort.", inputSchema: { request: z.string().min(1), override_tier: z.enum(TIERS).nullish() } },
    tool(async ({ request, override_tier }) => {
      const t = await triage(cfg, ctx.adapters, request, { cwd: ctx.repoDir, overrideTier: override_tier ?? undefined });
      const task = repo.insertTask({ request, phase: t.phase, tier: t.tier });
      const name = selectModel(cfg, t.tier, availability(repo));
      if (!name) repo.updateTask(task.id, { status: "waiting_quota" });
      const model = name ? cfg.models[name] : undefined;
      return {
        task_id: task.id, phase: t.phase, tier: t.tier, model: name, adapter: model?.adapter ?? null, effort: t.effort,
        next: !name ? "wait" : t.tier === "strong" ? "plan" : "run",
      };
    }),
  );

  server.registerTool(
    "plan",
    { description: "Split a task into steps with the strong model.", inputSchema: { task_id: z.string() } },
    tool(async ({ task_id }) => {
      mustTask(task_id);
      const steps = await plan(cfg, ctx.adapters, repo, task_id, { cwd: ctx.repoDir });
      const seqOf = new Map(steps.map((s) => [s.id, s.seq]));
      return {
        steps: steps.map((s) => ({ seq: s.seq, tier: s.tier, brief: s.brief, depends_on: s.depends_on.map((d) => seqOf.get(d)), files: s.files })),
      };
    }),
  );

  server.registerTool(
    "run_plan",
    { description: "Start executing the steps of a task; returns at once.", inputSchema: { task_id: z.string() } },
    tool(async ({ task_id }) => {
      mustTask(task_id);
      const steps = repo.listSteps(task_id);
      // Sem await: um plano leva minutos e o cliente MCP acompanha por `status`.
      runPlan(stepDeps, task_id).catch((e) => console.error(`run_plan ${task_id}:`, e));
      return {
        started: steps.filter((s) => s.depends_on.length === 0).map((s) => s.seq),
        waiting: steps.filter((s) => s.depends_on.length > 0).map((s) => s.seq),
      };
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
