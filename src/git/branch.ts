import { join } from "node:path";
import type { Exec } from "../exec.ts";

async function must(exec: Exec, cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await exec(cmd, args, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function startBranch(exec: Exec, o: { repoDir: string; branch: string; base: string; local?: boolean; from?: string }): Promise<string> {
  const worktree = join(o.repoDir, ".worktrees", o.branch.replaceAll("/", "-"));
  // Parte do remoto atualizado: passos dependentes precisam enxergar o que já foi mergeado no base.
  // Modo local não tem remoto: parte do base local, que já recebe os merges dos passos anteriores.
  if (!o.local) await must(exec, "git", ["fetch", "origin", o.base], o.repoDir);
  await must(exec, "git", ["worktree", "add", "-b", o.branch, worktree, o.from ?? (o.local ? o.base : `origin/${o.base}`)], o.repoDir);
  return worktree;
}

export async function commitAll(exec: Exec, o: { worktree: string; title: string }): Promise<boolean> {
  await must(exec, "git", ["add", "-A"], o.worktree);
  if (!(await must(exec, "git", ["status", "--porcelain"], o.worktree)).trim()) return false;
  await must(exec, "git", ["commit", "-m", o.title], o.worktree);
  return true;
}

export type Published = { changed: false } | { changed: true; pr_number: number };

type PushOptions = { worktree: string; branch: string; base: string; title: string; body: string; pr_number?: number };

export async function publishBranch(exec: Exec, o: PushOptions): Promise<Published> {
  if (!(await commitAll(exec, o))) return { changed: false };
  return pushBranch(exec, o);
}

// Push + PR de um branch já commitado (o estágio 2 do modo staged chega aqui depois do gate local).
export async function pushBranch(exec: Exec, o: PushOptions): Promise<{ changed: true; pr_number: number }> {
  await must(exec, "git", ["push", "-u", "--force-with-lease", "origin", o.branch], o.worktree);
  if (o.pr_number) return { changed: true, pr_number: o.pr_number };
  const out = await must(
    exec,
    "gh",
    ["pr", "create", "--title", o.title, "--body", o.body, "--base", o.base, "--head", o.branch],
    o.worktree,
  );
  const n = out.match(/\/pull\/(\d+)/)?.[1];
  if (!n) throw new Error(`gh pr create: no PR number in output: ${out}`);
  return { changed: true, pr_number: Number(n) };
}
