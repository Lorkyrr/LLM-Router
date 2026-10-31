import { join } from "node:path";
import type { Config, Tier } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability } from "../catalog/check.ts";
import type { Exec } from "../exec.ts";
import { commitAll, publishBranch, startBranch } from "../git/branch.ts";
import { estimateCost } from "../policy/cost.ts";
import { stepFor } from "../policy/escalate.ts";
import type { Lease } from "./lease.ts";
import { selectModel } from "../policy/select.ts";
import type { Repo, Runner } from "../store/repo.ts";
import { verifyAndMerge } from "../verify/ci.ts";
import { verifyLocal } from "../verify/local.ts";

export type StepDeps = {
  cfg: Config;
  adapters: Record<AdapterName, Adapter>;
  repo: Repo;
  exec: Exec;
  repoDir: string;
  base: string;
  runner: Runner;
  lease?: Lease;
};
export type StepOutcome =
  | { status: "done"; attempts: number }
  | { status: "failed"; attempts: number; reason: string }
  | { status: "waiting_quota"; attempts: number };

// Teto por agente e por espera de CI: sem isso um CLI ou `gh pr checks --watch` travado prende o passo para sempre.
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const CI_TIMEOUT_MS = 30 * 60 * 1000;

// Sessão nova a cada tentativa: o agente só vê o brief e o motivo da falha anterior, nunca o histórico.
const promptFor = (brief: string, lastFailure: string | null) =>
  lastFailure ? `${brief}\n\nA tentativa anterior falhou: ${lastFailure}\nCorrija isso neste mesmo branch.` : brief;

export async function runStep(d: StepDeps, stepId: string): Promise<StepOutcome> {
  const { cfg, repo } = d;
  const local = cfg.verify.mode === "local";
  const step = repo.getStep(stepId);
  if (!step) throw new Error(`run-step: unknown step ${stepId}`);
  // Numeração continua de onde parou para a retomada de um passo failed/waiting_quota não repetir n.
  let n = repo.listAttempts(stepId).length;
  if (step.status === "done") return { status: "done", attempts: n };

  let open: { id: string; usage: Parameters<Repo["finishAttempt"]>[1] } | null = null;
  const finish = (r: Parameters<Repo["finishAttempt"]>[1]) => {
    if (open) repo.finishAttempt(open.id, { ...open.usage, ...r });
    open = null;
  };

  try {
    repo.updateStep(stepId, { status: "running" });
    // Branch gravado = worktree já existe (mesma derivação de startBranch); só grava depois de criar com sucesso.
    let branch = step.branch;
    let worktree: string;
    if (branch) {
      worktree = join(d.repoDir, ".worktrees", branch.replaceAll("/", "-"));
    } else {
      branch = `router/step-${step.id.slice(0, 8)}`;
      worktree = await startBranch(d.exec, { repoDir: d.repoDir, branch, base: d.base, local });
      repo.updateStep(stepId, { branch });
    }

    let rung = 1;
    let prNumber = step.pr_number;
    let lastFailure: string | null = null;

    for (;;) {
      const rungStep = stepFor(cfg, step.tier as Tier, rung);
      if (!rungStep) {
        repo.updateStep(stepId, { status: "failed" });
        return { status: "failed", attempts: n, reason: lastFailure ?? "no attempts left" };
      }
      const taskPhase = repo.getTask(step.task_id)?.phase;
      // Passos mid de um plano strong são implementação; escalada cheap→mid também.
      const phase = !taskPhase ? undefined : cfg.phases[taskPhase].tier === rungStep.tier ? taskPhase
        : rungStep.tier === "mid" ? "implementing" : rungStep.tier === "cheap" ? "simple_edit" : "integration";
      const name = selectModel(cfg, rungStep.tier, availability(repo), phase);
      if (!name) {
        repo.updateStep(stepId, { status: "waiting_quota" });
        return { status: "waiting_quota", attempts: n };
      }
      const model = cfg.models[name]!;
      const attempt = repo.insertAttempt({
        step_id: stepId, n: ++n, adapter: model.adapter, model: name, tier: rungStep.tier, effort: rungStep.effort, runner: d.runner,
      });
      open = { id: attempt.id, usage: {} };

      const run = await d.adapters[model.adapter].run({
        model: model.id, effort: rungStep.effort, prompt: promptFor(step.brief, lastFailure), cwd: worktree,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
      const usage = {
        input_tokens: run.usage.input_tokens, output_tokens: run.usage.output_tokens,
        cache_read_tokens: run.usage.cache_read_tokens, cache_write_tokens: run.usage.cache_write_tokens,
        est_cost_usd: run.cost_usd ?? estimateCost(model.price, run.usage),
      };
      open.usage = usage;

      if (!run.ok) {
        if (run.quota_exhausted) {
          // Sem cota não é falha do passo: marca o modelo e tenta o próximo da mesma categoria sem subir a escada.
          // upsert antes: sem a linha em `models` o UPDATE não pega e o laço escolheria o mesmo modelo para sempre.
          repo.upsertModel({ name, adapter: model.adapter, tier: rungStep.tier, preference: cfg.tiers[rungStep.tier].indexOf(name) });
          repo.setAvailability(name, { available: false, quota_state: "exhausted" });
          finish({ failure_reason: "quota exhausted" });
          continue;
        }
        lastFailure = run.error ?? "agent failed";
        finish({ failure_reason: lastFailure });
        rung++;
        continue;
      }

      const title = step.brief.split("\n")[0]!.slice(0, 72);
      let verdict;
      if (local) {
        if (!(await commitAll(d.exec, { worktree, title }))) {
          lastFailure = "agent made no changes";
          finish({ failure_reason: lastFailure });
          rung++;
          continue;
        }
        verdict = await verifyLocal(d.exec, {
          worktree, repoDir: d.repoDir, branch, base: d.base, testCmd: cfg.verify.test_cmd!, autoMerge: cfg.verify.auto_merge,
          timeoutMs: CI_TIMEOUT_MS,
        });
      } else {
        const pub = await publishBranch(d.exec, {
          worktree, branch, base: d.base, title, body: step.brief,
          ...(prNumber ? { pr_number: prNumber } : {}),
        });
        if (!pub.changed) {
          lastFailure = "agent made no changes";
          finish({ failure_reason: lastFailure });
          rung++;
          continue;
        }
        prNumber = pub.pr_number;
        repo.updateStep(stepId, { pr_number: prNumber });

        // O runner local só fica ligado enquanto o CI deste PR roda.
        await d.lease?.acquire();
        verdict = await verifyAndMerge(d.exec, {
          cwd: worktree, pr: prNumber, deleteBranch: cfg.verify.delete_branch, timeoutMs: CI_TIMEOUT_MS, branch,
        }).finally(() => d.lease?.release());
      }
      if (verdict.result === "passed") {
        // auto_merge off: o trabalho fica no branch/worktree para revisão; limpar apagaria o resultado.
        finish({ ci_result: "passed" });
        repo.updateStep(stepId, { status: "done" });
        return { status: "done", attempts: n };
      }
      if (verdict.result === "merged") {
        finish({ ci_result: "merged" });
        // Sem isto cada passo deixa um worktree e um branch local para trás; falha de limpeza não desfaz o merge.
        await d.exec("git", ["worktree", "remove", "--force", worktree], { cwd: d.repoDir });
        await d.exec("git", ["branch", "-D", branch], { cwd: d.repoDir });
        repo.updateStep(stepId, { status: "done" });
        return { status: "done", attempts: n };
      }
      lastFailure = verdict.reason;
      finish({ ci_result: verdict.result, failure_reason: verdict.reason });
      rung++;
    }
  } catch (e) {
    // Qualquer exceção (git, CLI, gh, runner) vira falha do passo: sem isso ele ficaria `running` e o attempt aberto.
    const reason = e instanceof Error ? e.message : String(e);
    finish({ failure_reason: reason });
    repo.updateStep(stepId, { status: "failed" });
    return { status: "failed", attempts: n, reason };
  }
}
