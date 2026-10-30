import { join } from "node:path";
import type { Exec } from "../exec.ts";

async function must(exec: Exec, cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await exec(cmd, args, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function startBranch(exec: Exec, o: { repoDir: string; branch: string; base: string }): Promise<string> {
  const worktree = join(o.repoDir, ".worktrees", o.branch.replaceAll("/", "-"));
  await must(exec, "git", ["worktree", "add", "-b", o.branch, worktree, o.base], o.repoDir);
  return worktree;
}

export type Published = { changed: false } | { changed: true; pr_number: number };

export async function publishBranch(
  exec: Exec,
  o: { worktree: string; branch: string; base: string; title: string; body: string },
): Promise<Published> {
  await must(exec, "git", ["add", "-A"], o.worktree);
  if (!(await must(exec, "git", ["status", "--porcelain"], o.worktree)).trim()) return { changed: false };
  await must(exec, "git", ["commit", "-m", o.title], o.worktree);
  await must(exec, "git", ["push", "-u", "origin", o.branch], o.worktree);
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
