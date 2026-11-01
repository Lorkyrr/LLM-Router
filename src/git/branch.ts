import { join } from "node:path";
import type { Exec } from "../exec.ts";

async function must(exec: Exec, cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await exec(cmd, args, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Base explícita (ROUTER_BASE) vence. Modo local sem ela segue o branch do checkout, que é onde o ff-merge acontece
// (verifyLocal exige HEAD == base); um "main" fixo criava worktrees a partir de um main local defasado.
export async function resolveBase(exec: Exec, o: { repoDir: string; local: boolean; configured?: string }): Promise<string> {
  if (o.configured) return o.configured;
  if (!o.local) return "main";
  const r = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: o.repoDir });
  const head = r.stdout.trim();
  return r.code === 0 && head && head !== "HEAD" ? head : "main";
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

// Backup do branch em origin. Falha (sem rede/credencial) vira aviso, nunca derruba o passo: o próximo push tenta de novo.
// --force-with-lease: o rebase do gate local reescreve um branch já publicado.
export async function backupBranch(exec: Exec, o: { worktree: string; branch: string }): Promise<void> {
  const r = await exec("git", ["push", "-u", "--force-with-lease", "origin", o.branch], { cwd: o.worktree });
  if (r.code !== 0) console.error(`push de ${o.branch} para origin falhou (tenta de novo no próximo push): ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
}

// Nunca reescreve o base remoto. Um push seguinte publica também os merges que ficaram pendentes.
export async function backupBase(exec: Exec, o: { repoDir: string; base: string }): Promise<boolean> {
  try {
    const r = await exec("git", ["push", "origin", `refs/heads/${o.base}:refs/heads/${o.base}`], { cwd: o.repoDir, timeoutMs: 60_000 });
    if (r.code === 0) return true;
    throw new Error(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`);
  } catch (e) {
    console.error(`push de ${o.base} para origin falhou (tenta de novo no próximo push): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function deleteRemoteBranch(exec: Exec, o: { repoDir: string; branch: string }): Promise<void> {
  const r = await exec("git", ["push", "origin", "--delete", o.branch], { cwd: o.repoDir });
  if (r.code !== 0) console.error(`apagar ${o.branch} em origin falhou: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
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
