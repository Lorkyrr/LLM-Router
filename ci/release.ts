import { join } from "node:path";
import { realExec, type Exec } from "../src/exec.ts";

export type Pr = { number: number; headRefName: string; files: string[] };
export type Outcome = {
  merged: number[];
  failed: { pr: number; reason: string }[];
  conflict: number[];
  skipped: { pr: number; reason: string }[];
  overlaps: { file: string; prs: number[] }[];
};

const TAIL_LINES = 60;

// Arquivos tocados por mais de um PR: é o que a comparação entre PRs mostra antes de qualquer merge.
export function overlaps(prs: Pr[]): Outcome["overlaps"] {
  const by = new Map<string, number[]>();
  for (const p of prs) for (const f of p.files) by.set(f, [...(by.get(f) ?? []), p.number]);
  return [...by].filter(([, n]) => n.length > 1).map(([file, n]) => ({ file, prs: n }));
}

async function listPrs(exec: Exec, o: { cwd: string; base: string; prefix: string }): Promise<Pr[]> {
  const r = await exec("gh", ["pr", "list", "--state", "open", "--base", o.base, "--limit", "100", "--json", "number,headRefName,files"], { cwd: o.cwd });
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr || r.stdout}`);
  const raw = JSON.parse(r.stdout) as { number: number; headRefName: string; files: { path: string }[] }[];
  // Ordem de abertura: passos dependentes são abertos depois dos pré-requisitos.
  return raw
    .filter((p) => p.headRefName.startsWith(o.prefix))
    .map((p) => ({ number: p.number, headRefName: p.headRefName, files: p.files.map((f) => f.path) }))
    .sort((a, b) => a.number - b.number);
}

// Sinal do usuário: compara todos os PRs abertos do router, roda o CI de cada um sobre o base atualizado,
// faz merge dos verdes e apaga o branch. Vermelho/conflito fica aberto com comentário e não bloqueia os independentes.
export async function release(
  exec: Exec,
  o: { cwd: string; base: string; prefix: string; ciCmd: string[]; tmpDir: string; ciTimeoutMs?: number; deleteBranch?: boolean },
): Promise<Outcome> {
  const prs = await listPrs(exec, o);
  const out: Outcome = { merged: [], failed: [], conflict: [], skipped: [], overlaps: overlaps(prs) };
  const unmerged = new Map<number, string>(); // PRs que falharam ou foram pulados, com o branch

  for (const pr of prs) {
    const ref = `origin/${pr.headRefName}`;
    const fetched = await exec("git", ["fetch", "origin", o.base, pr.headRefName], { cwd: o.cwd });
    if (fetched.code !== 0) {
      out.failed.push({ pr: pr.number, reason: `git fetch: ${fetched.stderr || fetched.stdout}` });
      unmerged.set(pr.number, ref);
      continue;
    }
    // PR empilhado sobre um que não foi mergeado carregaria os commits dele para a base.
    let blockedBy: number | undefined;
    for (const [n, otherRef] of unmerged) {
      if ((await exec("git", ["merge-base", "--is-ancestor", otherRef, ref], { cwd: o.cwd })).code === 0) blockedBy = n;
    }
    if (blockedBy !== undefined) {
      out.skipped.push({ pr: pr.number, reason: `stacked on #${blockedBy}, which was not merged` });
      unmerged.set(pr.number, ref);
      continue;
    }

    const wt = join(o.tmpDir, `pr-${pr.number}`);
    const fail = async (reason: string, conflict = false) => {
      conflict ? out.conflict.push(pr.number) : out.failed.push({ pr: pr.number, reason });
      unmerged.set(pr.number, ref);
      await exec("gh", ["pr", "comment", String(pr.number), "--body-file", "-"], { cwd: o.cwd, input: `router release: not merged.\n\n\`\`\`\n${reason}\n\`\`\`` });
    };
    const added = await exec("git", ["worktree", "add", "--detach", wt, ref], { cwd: o.cwd });
    if (added.code !== 0) {
      await fail(`git worktree add: ${added.stderr || added.stdout}`);
      continue;
    }
    try {
      const rebase = await exec("git", ["rebase", `origin/${o.base}`], { cwd: wt });
      if (rebase.code !== 0) {
        await exec("git", ["rebase", "--abort"], { cwd: wt });
        await fail(`rebase onto origin/${o.base}: ${rebase.stderr || rebase.stdout}`, true);
        continue;
      }
      const [cmd, ...args] = o.ciCmd as [string, ...string[]];
      const ci = await exec(cmd, args, { cwd: wt, timeoutMs: o.ciTimeoutMs });
      if (ci.code !== 0) {
        await fail(`$ ${o.ciCmd.join(" ")} (exit ${ci.code})\n${(ci.stdout + ci.stderr).trim().split("\n").slice(-TAIL_LINES).join("\n")}`);
        continue;
      }
      const merge = await exec("gh", ["pr", "merge", String(pr.number), "--rebase"], { cwd: o.cwd });
      if (merge.code !== 0) {
        await fail(`gh pr merge: ${merge.stderr.trim() || merge.stdout.trim()}`);
        continue;
      }
      out.merged.push(pr.number);
      // Melhor esforço: o merge já aconteceu.
      if (o.deleteBranch !== false) await exec("git", ["push", "origin", "--delete", pr.headRefName], { cwd: o.cwd });
    } finally {
      await exec("git", ["worktree", "remove", "--force", wt], { cwd: o.cwd });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const flags = sep < 0 ? argv : argv.slice(0, sep);
  const ciCmd = sep < 0 ? [] : argv.slice(sep + 1);
  const flag = (n: string, d: string) => flags[flags.indexOf(n) + 1] && flags.includes(n) ? flags[flags.indexOf(n) + 1]! : d;
  if (!ciCmd.length) throw new Error("usage: release.ts [--base main] [--prefix router/] -- <ci command...>");
  const tmpDir = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp";
  const out = await release(realExec, { cwd: process.cwd(), base: flag("--base", "main"), prefix: flag("--prefix", "router/"), ciCmd, tmpDir, ciTimeoutMs: 30 * 60 * 1000 });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.failed.length + out.conflict.length + out.skipped.length ? 1 : 0);
}
