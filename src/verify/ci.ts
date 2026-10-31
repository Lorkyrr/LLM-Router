import type { Exec } from "../exec.ts";

export type Verdict = { result: "merged" } | { result: "passed" } | { result: "failed"; reason: string } | { result: "conflict"; reason: string };

const NO_CHECKS = /no checks reported/i;
const NO_CHECKS_RETRIES = 6;
const NO_CHECKS_POLL_MS = 5000;
// "base branch policy prohibits the merge" (revisão obrigatória etc.) não é conflito: só conflito real de merge.
const CONFLICT = /merge conflict|conflicts|cannot be rebased/i;
const LOG_TAIL_LINES = 60;
const RUN_ID = /\/runs\/(\d+)/;
const conflictReason = (base: string) => `merge conflict: rebase no origin/${base}, resolva os conflitos e dê push`;

// Melhor esforço: o reason já tem a tabela de checks; o log do job falho só enriquece.
async function failedLogTail(exec: Exec, cwd: string, pr: string): Promise<string> {
  const list = await exec("gh", ["pr", "checks", pr, "--json", "bucket,link"], { cwd });
  if (list.code !== 0) return "";
  let runId: string | undefined;
  try {
    const checks = JSON.parse(list.stdout) as { bucket: string; link: string }[];
    runId = checks.find((c) => c.bucket === "fail")?.link.match(RUN_ID)?.[1];
  } catch {
    return "";
  }
  if (!runId) return "";
  const log = await exec("gh", ["run", "view", runId, "--log-failed"], { cwd });
  return log.code === 0 ? log.stdout.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n") : "";
}

export async function verifyAndMerge(
  exec: Exec,
  o: { cwd: string; pr: number; deleteBranch: boolean; autoMerge?: boolean; branch?: string; base?: string; timeoutMs?: number; pollMs?: number },
): Promise<Verdict> {
  const pr = String(o.pr);
  const base = o.base ?? "main";
  const view = await exec("gh", ["pr", "view", pr, "--json", "mergeable"], { cwd: o.cwd });
  if (view.code === 0 && JSON.parse(view.stdout).mergeable === "CONFLICTING") {
    return { result: "conflict", reason: conflictReason(base) };
  }

  // `--watch` bloqueia até os checks terminarem; exit 0 = verde, 1 = vermelho, 8 = ainda pendente (timeout).
  // Logo após abrir o PR o workflow ainda não registrou checks e o gh sai com erro; espera um pouco antes de desistir.
  let checks = await exec("gh", ["pr", "checks", pr, "--watch"], { cwd: o.cwd, timeoutMs: o.timeoutMs });
  for (let i = 0; i < NO_CHECKS_RETRIES && NO_CHECKS.test(checks.stdout + checks.stderr); i++) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? NO_CHECKS_POLL_MS));
    checks = await exec("gh", ["pr", "checks", pr, "--watch"], { cwd: o.cwd, timeoutMs: o.timeoutMs });
  }
  if (checks.code !== 0) {
    const table = checks.stdout.trim() || checks.stderr.trim() || `gh pr checks exit ${checks.code}`;
    const tail = await failedLogTail(exec, o.cwd, pr);
    return { result: "failed", reason: tail ? `${table}\n\n--- failed job log (last ${LOG_TAIL_LINES} lines) ---\n${tail}` : table };
  }

  // auto_merge off: CI verde e PR aberto para revisão humana.
  if (o.autoMerge === false) return { result: "passed" };

  // --delete-branch tenta dar checkout do base dentro do worktree e falha; apaga o remoto à parte.
  const merge = await exec("gh", ["pr", "merge", pr, "--rebase"], { cwd: o.cwd });
  if (merge.code === 0) {
    // Melhor esforço: o merge já aconteceu, branch remoto sobrando não invalida o passo.
    if (o.deleteBranch && o.branch) await exec("git", ["push", "origin", "--delete", o.branch], { cwd: o.cwd });
    return { result: "merged" };
  }
  const reason = merge.stderr.trim() || merge.stdout.trim() || `gh pr merge exit ${merge.code}`;
  return CONFLICT.test(reason) ? { result: "conflict", reason: `${conflictReason(base)} (${reason})` } : { result: "failed", reason };
}
