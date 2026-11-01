import { join } from "node:path";
import type { Exec } from "../exec.ts";
import type { Repo } from "../store/repo.ts";
import type { Lease } from "./lease.ts";

export type ReleaseDeps = { exec: Exec; repo: Repo; repoDir: string; base: string; lease?: Lease };

const WORKFLOW = "router-release.yml";
const FIND_RUN_TRIES = 12;
const FIND_RUN_POLL_MS = 5000;
const RUN_TIMEOUT_MS = 90 * 60 * 1000;

// Passos staged ficam em pr_open até o sinal. Aqui o estado local acompanha o que o GitHub fez: PR mergeado vira done
// (e perde worktree/branch locais), PR fechado sem merge vira failed, PR aberto continua esperando.
export async function syncReleased(d: ReleaseDeps): Promise<{ merged: number[]; closed: number[]; open: number[] }> {
  const out = { merged: [] as number[], closed: [] as number[], open: [] as number[] };
  const tasks = new Set<string>();
  for (const step of d.repo.listStepsByStatus("pr_open")) {
    if (!step.pr_number) continue;
    tasks.add(step.task_id);
    const view = await d.exec("gh", ["pr", "view", String(step.pr_number), "--json", "state", "--jq", ".state"], { cwd: d.repoDir });
    const state = view.stdout.trim();
    if (view.code !== 0 || (state !== "MERGED" && state !== "CLOSED")) {
      out.open.push(step.pr_number);
    } else if (state === "MERGED") {
      out.merged.push(step.pr_number);
      d.repo.updateStep(step.id, { status: "done" });
      if (step.branch) {
        // Melhor esforço: o merge já aconteceu.
        await d.exec("git", ["worktree", "remove", "--force", join(d.repoDir, ".worktrees", step.branch.replaceAll("/", "-"))], { cwd: d.repoDir });
        await d.exec("git", ["branch", "-D", step.branch], { cwd: d.repoDir });
      }
    } else {
      out.closed.push(step.pr_number);
      d.repo.updateStep(step.id, { status: "failed" });
    }
  }
  for (const id of tasks) {
    const steps = d.repo.listSteps(id);
    const status = steps.some((s) => s.status === "failed") ? "failed" : steps.some((s) => s.status === "awaiting_review") ? "awaiting_review" : steps.some((s) => s.status === "pr_open") ? "awaiting_release" : "done";
    d.repo.updateTask(id, { status });
  }
  return out;
}

// O sinal do usuário: dispara o workflow do GitHub, que compara todos os PRs router/*, roda o CI, faz merge e apaga os
// branches. O runner local só fica ligado enquanto o workflow roda. Retorna ao disparar; `done` fecha quando termina.
export async function dispatchRelease(
  d: ReleaseDeps,
  o: { pollMs?: number; now?: () => number } = {},
): Promise<{ prs: number[]; done: Promise<void> }> {
  const prs = d.repo.listStepsByStatus("pr_open").flatMap((s) => (s.pr_number ? [s.pr_number] : []));
  if (!prs.length) throw new Error("nothing to release: no step has an open PR waiting (run_plan in staged mode creates them)");

  await d.lease?.acquire();
  const at = (o.now ?? Date.now)();
  const dispatched = await d.exec("gh", ["workflow", "run", WORKFLOW, "--ref", d.base], { cwd: d.repoDir }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (dispatched.code !== 0) {
    await d.lease?.release();
    throw new Error(`gh workflow run ${WORKFLOW} failed: ${dispatched.stderr || dispatched.stdout}`);
  }

  const done = (async () => {
    try {
      let runId: number | undefined;
      for (let i = 0; i < FIND_RUN_TRIES && !runId; i++) {
        if (i) await new Promise((r) => setTimeout(r, o.pollMs ?? FIND_RUN_POLL_MS));
        const list = await d.exec("gh", ["run", "list", "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--limit", "5", "--json", "databaseId,createdAt"], { cwd: d.repoDir });
        if (list.code !== 0) continue;
        const runs = JSON.parse(list.stdout) as { databaseId: number; createdAt: string }[];
        // 5 s de folga: o relógio do GitHub e o local não são o mesmo.
        runId = runs.find((r) => Date.parse(r.createdAt) >= at - 5000)?.databaseId;
      }
      if (runId) await d.exec("gh", ["run", "watch", String(runId), "--exit-status"], { cwd: d.repoDir, timeoutMs: RUN_TIMEOUT_MS });
      else console.error("release: workflow run not found; syncing without waiting");
    } catch (e) {
      console.error("release:", e);
    } finally {
      await d.lease?.release();
      await syncReleased(d).catch((e) => console.error("release sync:", e));
    }
  })();
  return { prs, done };
}
