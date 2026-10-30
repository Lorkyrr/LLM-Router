import type { Config, Tier } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability } from "../catalog/check.ts";
import type { Exec } from "../exec.ts";
import { publishBranch, startBranch } from "../git/branch.ts";
import { estimateCost } from "../policy/cost.ts";
import { stepFor } from "../policy/escalate.ts";
import { selectModel } from "../policy/select.ts";
import type { Repo, Runner } from "../store/repo.ts";
import { verifyAndMerge } from "../verify/ci.ts";

export type StepDeps = {
  cfg: Config;
  adapters: Record<AdapterName, Adapter>;
  repo: Repo;
  exec: Exec;
  repoDir: string;
  base: string;
  runner: Runner;
};
export type StepOutcome =
  | { status: "done"; attempts: number }
  | { status: "failed"; attempts: number; reason: string }
  | { status: "waiting_quota"; attempts: number };

// Sessão nova a cada tentativa: o agente só vê o brief e o motivo da falha anterior, nunca o histórico.
const promptFor = (brief: string, lastFailure: string | null) =>
  lastFailure ? `${brief}\n\nA tentativa anterior falhou: ${lastFailure}\nCorrija isso neste mesmo branch.` : brief;

export async function runStep(d: StepDeps, stepId: string): Promise<StepOutcome> {
  const { cfg, repo } = d;
  const step = repo.getStep(stepId);
  if (!step) throw new Error(`run-step: unknown step ${stepId}`);
  const branch = `router/step-${step.id.slice(0, 8)}`;
  repo.updateStep(stepId, { status: "running", branch });
  const worktree = await startBranch(d.exec, { repoDir: d.repoDir, branch, base: d.base });

  let rung = 1;
  let n = 0;
  let prNumber: number | null = null;
  let lastFailure: string | null = null;

  for (;;) {
    const rungStep = stepFor(cfg, step.tier as Tier, rung);
    if (!rungStep) {
      repo.updateStep(stepId, { status: "failed" });
      return { status: "failed", attempts: n, reason: lastFailure ?? "no attempts left" };
    }
    const name = selectModel(cfg, rungStep.tier, availability(repo));
    if (!name) {
      repo.updateStep(stepId, { status: "waiting_quota" });
      return { status: "waiting_quota", attempts: n };
    }
    const model = cfg.models[name]!;
    const attempt = repo.insertAttempt({
      step_id: stepId, n: ++n, adapter: model.adapter, model: name, tier: rungStep.tier, effort: rungStep.effort, runner: d.runner,
    });

    const run = await d.adapters[model.adapter].run({
      model: model.id, effort: rungStep.effort, prompt: promptFor(step.brief, lastFailure), cwd: worktree,
    });
    const usage = {
      input_tokens: run.usage.input_tokens, output_tokens: run.usage.output_tokens,
      cache_read_tokens: run.usage.cache_read_tokens, cache_write_tokens: run.usage.cache_write_tokens,
      est_cost_usd: run.cost_usd ?? estimateCost(model.price, run.usage),
    };

    if (!run.ok) {
      if (run.quota_exhausted) {
        // Sem cota não é falha do passo: marca o modelo e tenta o próximo da mesma categoria sem subir a escada.
        // upsert antes: sem a linha em `models` o UPDATE não pega e o laço escolheria o mesmo modelo para sempre.
        repo.upsertModel({ name, adapter: model.adapter, tier: rungStep.tier, preference: cfg.tiers[rungStep.tier].indexOf(name) });
        repo.setAvailability(name, { available: false, quota_state: "exhausted" });
        repo.finishAttempt(attempt.id, { ...usage, failure_reason: "quota exhausted" });
        continue;
      }
      lastFailure = run.error ?? "agent failed";
      repo.finishAttempt(attempt.id, { ...usage, failure_reason: lastFailure });
      rung++;
      continue;
    }

    const pub = await publishBranch(d.exec, {
      worktree, branch, base: d.base, title: step.brief.split("\n")[0]!.slice(0, 72), body: step.brief,
      ...(prNumber ? { pr_number: prNumber } : {}),
    });
    if (!pub.changed) {
      lastFailure = "agent made no changes";
      repo.finishAttempt(attempt.id, { ...usage, failure_reason: lastFailure });
      rung++;
      continue;
    }
    prNumber = pub.pr_number;
    repo.updateStep(stepId, { pr_number: prNumber });

    const verdict = await verifyAndMerge(d.exec, { cwd: worktree, pr: prNumber, deleteBranch: cfg.verify.delete_branch });
    if (verdict.result === "merged") {
      repo.finishAttempt(attempt.id, { ...usage, ci_result: "merged" });
      repo.updateStep(stepId, { status: "done" });
      return { status: "done", attempts: n };
    }
    lastFailure = verdict.reason;
    repo.finishAttempt(attempt.id, { ...usage, ci_result: verdict.result, failure_reason: verdict.reason });
    rung++;
  }
}
