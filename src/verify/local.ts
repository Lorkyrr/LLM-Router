import type { Exec } from "../exec.ts";
import type { Verdict } from "./ci.ts";

const LOG_TAIL_LINES = 60;

// Rebase + ff-merge de passos paralelos precisam ser serializados: o segundo só faz ff depois de rebasear no primeiro.
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const r = tail.then(f);
  tail = r.catch(() => {});
  return r;
};

const reason = (r: { stderr: string; stdout: string; code: number }) => r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;

// Estágio 1: cada comando roda no worktree, em ordem; o primeiro que falhar encerra e nomeia o comando no motivo.
export async function runLocalChecks(
  exec: Exec,
  o: { worktree: string; cmds: string[][]; timeoutMs?: number },
): Promise<{ result: "passed" } | { result: "failed"; reason: string }> {
  for (const argv of o.cmds) {
    const [cmd, ...args] = argv as [string, ...string[]];
    const r = await exec(cmd, args, { cwd: o.worktree, timeoutMs: o.timeoutMs });
    if (r.code !== 0) {
      const out = (r.stdout + r.stderr).trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
      return { result: "failed", reason: `$ ${argv.join(" ")} (exit ${r.code})\n${out}`.trim() };
    }
  }
  return { result: "passed" };
}

// `onto` é o ref do base: local no modo local, origin/<base> (após fetch) no staged. Conflito aborta o rebase e não deixa o worktree no meio.
export async function rebaseOnto(exec: Exec, o: { worktree: string; onto: string }): Promise<{ result: "rebased" } | { result: "conflict"; reason: string }> {
  const rebase = await exec("git", ["rebase", o.onto], { cwd: o.worktree });
  if (rebase.code === 0) return { result: "rebased" };
  await exec("git", ["rebase", "--abort"], { cwd: o.worktree });
  return { result: "conflict", reason: `merge conflict: rebase no ${o.onto}, resolva os conflitos (${reason(rebase)})` };
}

// Sem remoto nem CI: o teste local no worktree é o veredito. shortcut: não reroda os testes após o rebase, rode-os se base andar muito.
export async function verifyLocal(
  exec: Exec,
  o: { worktree: string; repoDir: string; branch: string; base: string; cmds: string[][]; autoMerge: boolean; timeoutMs?: number },
): Promise<Verdict> {
  const checks = await runLocalChecks(exec, o);
  if (checks.result === "failed") return checks;
  if (!o.autoMerge) return { result: "passed" };

  return serial(async (): Promise<Verdict> => {
    // O ff é feito no checkout do usuário: se ele estiver em outro branch, mergearia no lugar errado.
    const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: o.repoDir });
    if (head.stdout.trim() !== o.base) {
      return { result: "failed", reason: `${o.repoDir} is on "${head.stdout.trim()}": checkout ${o.base} to merge locally` };
    }
    const rebase = await rebaseOnto(exec, { worktree: o.worktree, onto: o.base });
    if (rebase.result === "conflict") return rebase;
    const merge = await exec("git", ["merge", "--ff-only", o.branch], { cwd: o.repoDir });
    return merge.code === 0 ? { result: "merged" } : { result: "failed", reason: reason(merge) };
  });
}
