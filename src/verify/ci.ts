import type { Exec } from "../exec.ts";

export type Verdict = { result: "merged" } | { result: "failed"; reason: string } | { result: "conflict"; reason: string };

const CONFLICT = /conflict|not mergeable|cannot be rebased/i;

export async function verifyAndMerge(
  exec: Exec,
  o: { cwd: string; pr: number; deleteBranch: boolean; timeoutMs?: number },
): Promise<Verdict> {
  const pr = String(o.pr);
  const view = await exec("gh", ["pr", "view", pr, "--json", "mergeable"], { cwd: o.cwd });
  if (view.code === 0 && JSON.parse(view.stdout).mergeable === "CONFLICTING") {
    return { result: "conflict", reason: "PR conflicts with the base branch" };
  }

  // `--watch` bloqueia até os checks terminarem; exit 0 = verde, 1 = vermelho, 8 = ainda pendente (timeout).
  const checks = await exec("gh", ["pr", "checks", pr, "--watch"], { cwd: o.cwd, timeoutMs: o.timeoutMs });
  if (checks.code !== 0) {
    return { result: "failed", reason: checks.stdout.trim() || checks.stderr.trim() || `gh pr checks exit ${checks.code}` };
  }

  const merge = await exec("gh", ["pr", "merge", pr, "--rebase", ...(o.deleteBranch ? ["--delete-branch"] : [])], { cwd: o.cwd });
  if (merge.code === 0) return { result: "merged" };
  const reason = merge.stderr.trim() || merge.stdout.trim() || `gh pr merge exit ${merge.code}`;
  return { result: CONFLICT.test(reason) ? "conflict" : "failed", reason };
}
