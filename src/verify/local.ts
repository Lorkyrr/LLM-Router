import type { Exec } from "../exec.ts";
import type { Verdict } from "./ci.ts";

export type LocalVerdict = Verdict | { result: "passed" };

const LOG_TAIL_LINES = 60;

// Rebase + ff-merge de passos paralelos precisam ser serializados: o segundo só faz ff depois de rebasear no primeiro.
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const r = tail.then(f);
  tail = r.catch(() => {});
  return r;
};

const reason = (r: { stderr: string; stdout: string; code: number }) => r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;

// Sem remoto nem CI: o teste local no worktree é o veredito. shortcut: não reroda os testes após o rebase, rode-os se base andar muito.
export async function verifyLocal(
  exec: Exec,
  o: { worktree: string; repoDir: string; branch: string; base: string; testCmd: string[]; autoMerge: boolean; timeoutMs?: number },
): Promise<LocalVerdict> {
  const [cmd, ...args] = o.testCmd as [string, ...string[]];
  const tests = await exec(cmd, args, { cwd: o.worktree, timeoutMs: o.timeoutMs });
  if (tests.code !== 0) {
    const out = (tests.stdout + tests.stderr).trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
    return { result: "failed", reason: out || `${o.testCmd.join(" ")} exit ${tests.code}` };
  }
  if (!o.autoMerge) return { result: "passed" };

  return serial(async (): Promise<LocalVerdict> => {
    // O ff é feito no checkout do usuário: se ele estiver em outro branch, mergearia no lugar errado.
    const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: o.repoDir });
    if (head.stdout.trim() !== o.base) {
      return { result: "failed", reason: `${o.repoDir} is on "${head.stdout.trim()}": checkout ${o.base} to merge locally` };
    }
    const rebase = await exec("git", ["rebase", o.base], { cwd: o.worktree });
    if (rebase.code !== 0) {
      await exec("git", ["rebase", "--abort"], { cwd: o.worktree });
      return { result: "conflict", reason: `merge conflict: rebase no ${o.base}, resolva os conflitos (${reason(rebase)})` };
    }
    const merge = await exec("git", ["merge", "--ff-only", o.branch], { cwd: o.repoDir });
    return merge.code === 0 ? { result: "merged" } : { result: "failed", reason: reason(merge) };
  });
}
