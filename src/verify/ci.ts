import type { Exec } from "../exec.ts";

export type Verdict = { result: "merged" } | { result: "failed"; reason: string } | { result: "conflict"; reason: string };

const NO_CHECKS = /no checks reported/i;
const NO_CHECKS_RETRIES = 6;
const NO_CHECKS_POLL_MS = 5000;
const CONFLICT = /conflict|not mergeable|cannot be rebased/i;

export async function verifyAndMerge(
  exec: Exec,
  o: { cwd: string; pr: number; deleteBranch: boolean; timeoutMs?: number; pollMs?: number },
): Promise<Verdict> {
  const pr = String(o.pr);
  const view = await exec("gh", ["pr", "view", pr, "--json", "mergeable"], { cwd: o.cwd });
  if (view.code === 0 && JSON.parse(view.stdout).mergeable === "CONFLICTING") {
    return { result: "conflict", reason: "PR conflicts with the base branch" };
  }

  // `--watch` bloqueia até os checks terminarem; exit 0 = verde, 1 = vermelho, 8 = ainda pendente (timeout).
  // Logo após abrir o PR o workflow ainda não registrou checks e o gh sai com erro; espera um pouco antes de desistir.
  let checks = await exec("gh", ["pr", "checks", pr, "--watch"], { cwd: o.cwd, timeoutMs: o.timeoutMs });
  for (let i = 0; i < NO_CHECKS_RETRIES && NO_CHECKS.test(checks.stdout + checks.stderr); i++) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? NO_CHECKS_POLL_MS));
    checks = await exec("gh", ["pr", "checks", pr, "--watch"], { cwd: o.cwd, timeoutMs: o.timeoutMs });
  }
  if (checks.code !== 0) {
    return { result: "failed", reason: checks.stdout.trim() || checks.stderr.trim() || `gh pr checks exit ${checks.code}` };
  }

  const merge = await exec("gh", ["pr", "merge", pr, "--rebase", ...(o.deleteBranch ? ["--delete-branch"] : [])], { cwd: o.cwd });
  if (merge.code === 0) return { result: "merged" };
  const reason = merge.stderr.trim() || merge.stdout.trim() || `gh pr merge exit ${merge.code}`;
  return { result: CONFLICT.test(reason) ? "conflict" : "failed", reason };
}
