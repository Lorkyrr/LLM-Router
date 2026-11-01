import { join } from "node:path";
import type { Config, Tier } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability } from "../catalog/check.ts";
import type { Exec } from "../exec.ts";
import { backupBranch, commitAll, deleteRemoteBranch, publishBranch, pushBranch, startBranch } from "../git/branch.ts";
import { estimateCost } from "../policy/cost.ts";
import { stepFor } from "../policy/escalate.ts";
import type { Lease } from "./lease.ts";
import { selectModel } from "../policy/select.ts";
import type { Repo, Runner } from "../store/repo.ts";
import { verifyAndMerge, type Verdict } from "../verify/ci.ts";
import { rebaseOnto, runLocalChecks, verifyLocal } from "../verify/local.ts";

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
  // staged: passou no gate local e o PR está aberto; o CI e o merge esperam o `release`.
  | { status: "pr_open"; attempts: number }
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
  const mode = cfg.verify.mode;
  const step = repo.getStep(stepId);
  if (!step) throw new Error(`run-step: unknown step ${stepId}`);
  // Numeração continua de onde parou para a retomada de um passo failed/waiting_quota não repetir n.
  let n = repo.listAttempts(stepId).length;
  if (step.status === "done" || step.status === "pr_open") return { status: step.status, attempts: n };

  let open: { id: string; usage: Parameters<Repo["finishAttempt"]>[1] } | null = null;
  const finish = (r: Parameters<Repo["finishAttempt"]>[1]) => {
    if (open) repo.finishAttempt(open.id, { ...open.usage, ...r });
    open = null;
  };

  const backup = async (b: string, w: string) => {
    if (cfg.verify.push === "always") await backupBranch(d.exec, { worktree: w, branch: b });
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
      // Pré-requisito com PR aberto (staged) ainda não está no base: o passo parte do branch dele, e os demais entram por merge.
      const stacked = step.depends_on.flatMap((id) => {
        const dep = repo.getStep(id);
        return dep?.status === "pr_open" && dep.branch ? [dep.branch] : [];
      });
      for (const b of stacked) {
        const f = await d.exec("git", ["fetch", "origin", b], { cwd: d.repoDir });
        if (f.code !== 0) throw new Error(`git fetch ${b} failed: ${f.stderr || f.stdout}`);
      }
      worktree = await startBranch(d.exec, {
        repoDir: d.repoDir, branch, base: d.base, local: mode === "local", ...(stacked[0] ? { from: `origin/${stacked[0]}` } : {}),
      });
      for (const b of stacked.slice(1)) {
        const m = await d.exec("git", ["merge", "--no-edit", `origin/${b}`], { cwd: worktree });
        if (m.code !== 0) {
          await d.exec("git", ["merge", "--abort"], { cwd: worktree });
          throw new Error(`merge of prerequisite ${b} failed: ${m.stderr || m.stdout}`);
        }
      }
      repo.updateStep(stepId, { branch });
      await backup(branch, worktree);
    }

    // `rung` = degrau da escada; `failures` = tentativas gastas (teto max_attempts). Falha não-quota tenta antes os
    // outros modelos do mesmo degrau (`tried`) e só então sobe o degrau.
    let rung = 1;
    let failures = 0;
    const tried = new Set<string>();
    let prNumber = step.pr_number;
    let lastFailure: string | null = null;

    for (;;) {
      const rungStep = failures >= cfg.escalation.max_attempts ? null : stepFor(cfg, step.tier as Tier, rung);
      if (!rungStep) {
        repo.updateStep(stepId, { status: "failed" });
        return { status: "failed", attempts: n, reason: lastFailure ?? "no attempts left" };
      }
      const taskPhase = repo.getTask(step.task_id)?.phase;
      // Passos mid de um plano strong são implementação; escalada cheap→mid também.
      const phase = !taskPhase ? undefined : cfg.phases[taskPhase].tier === rungStep.tier ? taskPhase
        : rungStep.tier === "mid" ? "implementing" : rungStep.tier === "cheap" ? "simple_edit" : "integration";
      const states: Record<string, { available: boolean }> = { ...availability(repo) };
      for (const t of tried) states[t] = { available: false };
      const name = selectModel(cfg, rungStep.tier, states, phase);
      if (!name && tried.size) {
        rung++;
        tried.clear();
        continue;
      }
      if (!name) {
        repo.updateStep(stepId, { status: "waiting_quota" });
        return { status: "waiting_quota", attempts: n };
      }
      const model = cfg.models[name]!;
      const attempt = repo.insertAttempt({
        step_id: stepId, n: ++n, adapter: model.adapter, model: name, tier: rungStep.tier, effort: rungStep.effort, runner: d.runner,
      });
      open = { id: attempt.id, usage: {} };

      const title = step.brief.split("\n")[0]!.slice(0, 72);
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
        // Trabalho parcial de uma tentativa que falhou também vai para origin (o modo pr deixa o commit ao publishBranch).
        if (mode !== "pr" && cfg.verify.push === "always" && (await commitAll(d.exec, { worktree, title }).catch(() => false))) {
          await backup(branch, worktree);
        }
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
        failures++;
        tried.add(name);
        continue;
      }

      // local e staged commitam antes do gate; o modo pr deixa o commit para o publishBranch.
      if (mode !== "pr" && !(await commitAll(d.exec, { worktree, title }))) {
        lastFailure = "agent made no changes";
        finish({ failure_reason: lastFailure });
        failures++;
        tried.add(name);
        continue;
      }
      if (mode !== "pr") await backup(branch, worktree);
      const localOpts = { worktree, cmds: cfg.verify.local?.cmds ?? [], timeoutMs: (cfg.verify.local?.timeout_s ?? 0) * 1000 };
      let verdict: Verdict;
      let stage = "";
      if (mode === "local") {
        verdict = await verifyLocal(d.exec, { ...localOpts, repoDir: d.repoDir, branch, base: d.base, autoMerge: cfg.verify.auto_merge });
      } else {
        // Estágio 1 (staged): rebase no remoto e checks locais; nada vai ao GitHub antes de passar.
        let gate: Verdict | null = null;
        if (mode === "staged") {
          const fetched = await d.exec("git", ["fetch", "origin", d.base], { cwd: worktree });
          if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr || fetched.stdout}`);
          const rebased = await rebaseOnto(d.exec, { worktree, onto: `origin/${d.base}` });
          const checks = rebased.result === "conflict" ? rebased : await runLocalChecks(d.exec, localOpts);
          if (checks.result !== "passed") gate = checks;
        }
        if (gate) {
          verdict = gate;
          stage = "local_";
        } else {
          // Modo pr: PR + CI do GitHub + merge agora. Staged: só abre o PR; CI e merge esperam o sinal (`release`).
          const pushOpts = { worktree, branch, base: d.base, title, body: step.brief, ...(prNumber ? { pr_number: prNumber } : {}) };
          const pub = mode === "pr" ? await publishBranch(d.exec, pushOpts) : await pushBranch(d.exec, pushOpts);
          if (!pub.changed) {
            lastFailure = "agent made no changes";
            finish({ failure_reason: lastFailure });
            failures++;
            tried.add(name);
            continue;
          }
          prNumber = pub.pr_number;
          repo.updateStep(stepId, { pr_number: prNumber });
          if (mode === "staged") {
            finish({ ci_result: "pr_open" });
            repo.updateStep(stepId, { status: "pr_open" });
            return { status: "pr_open", attempts: n };
          }

          // O runner local só fica ligado enquanto o CI deste PR roda.
          await d.lease?.acquire();
          verdict = await verifyAndMerge(d.exec, {
            cwd: worktree, pr: prNumber, deleteBranch: cfg.verify.delete_branch, autoMerge: cfg.verify.auto_merge,
            timeoutMs: CI_TIMEOUT_MS, branch,
          }).finally(() => d.lease?.release());
        }
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
        // Só o modo local mergeia aqui (pr/staged apagam o remoto no CI/release); sem merge o remoto fica como backup.
        if (mode === "local" && cfg.verify.delete_branch && cfg.verify.push === "always") await deleteRemoteBranch(d.exec, { repoDir: d.repoDir, branch });
        repo.updateStep(stepId, { status: "done" });
        return { status: "done", attempts: n };
      }
      lastFailure = verdict.reason;
      finish({ ci_result: stage + verdict.result, failure_reason: verdict.reason });
      failures++;
      tried.add(name);
    }
  } catch (e) {
    // Qualquer exceção (git, CLI, gh, runner) vira falha do passo: sem isso ele ficaria `running` e o attempt aberto.
    const reason = e instanceof Error ? e.message : String(e);
    finish({ failure_reason: reason });
    repo.updateStep(stepId, { status: "failed" });
    return { status: "failed", attempts: n, reason };
  }
}
