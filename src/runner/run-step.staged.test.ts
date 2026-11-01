import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { Adapter } from "../adapters/types.ts";
import { realExec, type Exec } from "../exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { release } from "../../ci/release.ts";
import { syncReleased } from "./release.ts";
import { runStep } from "./run-step.ts";

// Git real com remoto bare; só o `gh` é falso (o merge dele é um push para main). Prova push-só-depois-do-gate, PR sem CI/merge
// até o sinal, e o release (ci/release.ts) mergeando e apagando o branch.
const git = async (cwd: string, ...args: string[]) => {
  const result = await realExec("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};
const cfg0 = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 };

test("staged end to end: failing gate pushes nothing, passing gate opens the PR, and only the release signal merges and deletes the branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "router-staged-"));
  const remote = join(root, "remote.git");
  const dir = join(root, "work");
  await git(root, "init", "--bare", "-b", "main", remote);
  await git(root, "clone", remote, dir);
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "init");
  await git(dir, "push", "origin", "HEAD:main");

  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "crie b.txt", tier: "mid", depends_on: [], files: [] });
  let runs = 0;
  const adapter: Adapter = {
    async run(i) {
      // 1ª tentativa deixa o arquivo errado (gate vermelho), a 2ª o corrige.
      writeFileSync(join(i.cwd, runs++ === 0 ? "wrong.txt" : "b.txt"), "b\n");
      return { ok: true, text: "feito", usage, cost_usd: 0, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const pushes: string[] = [];
  const ghCalls: string[] = [];
  let merged = false;
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "push" && !args.includes("--delete")) pushes.push(String(runs));
    if (cmd !== "gh") return realExec(cmd, args, opts);
    ghCalls.push(args.slice(0, 2).join(" "));
    const branch = repo.getStep(step.id)!.branch!;
    if (args[1] === "create") return { code: 0, stdout: "https://github.com/o/r/pull/9", stderr: "" };
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: 9, headRefName: branch, files: [{ path: "b.txt" }] }]), stderr: "" };
    if (args[1] === "merge") {
      merged = true;
      return realExec("git", ["push", "origin", `refs/remotes/origin/${branch}:refs/heads/main`], opts);
    }
    if (args[1] === "view") return { code: 0, stdout: merged ? "MERGED\n" : "OPEN\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const cfg = { ...cfg0, verify: { ...cfg0.verify, mode: "staged" as const, local: { cmds: [["test", "-f", "b.txt"]], timeout_s: 60 } } };
  const deps = { cfg, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repo, exec, repoDir: dir, base: "main", runner: "self_hosted" as const };
  const out = await runStep(deps, step.id);

  // Estágio local: PR aberto, nada de CI nem merge.
  assert.deepEqual(out, { status: "pr_open", attempts: 2 });
  assert.deepEqual(repo.listAttempts(step.id).map((a) => a.ci_result), ["local_failed", "pr_open"]);
  assert.deepEqual(pushes, ["2"]); // um só push, depois da 2ª rodada do agente
  assert.ok(ghCalls.includes("pr create") && !ghCalls.includes("pr merge") && !ghCalls.includes("pr checks"));
  const branch = repo.getStep(step.id)!.branch!;
  assert.match(await git(dir, "ls-remote", "--heads", "origin", branch), /refs\/heads\/router/);
  await assert.rejects(() => git(dir, "cat-file", "-e", "origin/main:b.txt"));

  // Sinal: compara os PRs, roda o CI de cada um, mergeia e apaga o branch remoto.
  const outcome = await release(exec, { cwd: dir, base: "main", prefix: "router/", ciCmd: ["test", "-f", "b.txt"], tmpDir: root });
  assert.deepEqual(outcome.merged, [9]);
  await git(dir, "fetch", "origin", "main");
  assert.equal(await git(dir, "show", "origin/main:b.txt"), "b");
  assert.equal(await git(dir, "ls-remote", "--heads", "origin", branch), "");

  // O estado local acompanha o GitHub: passo done, worktree e branch locais removidos.
  assert.deepEqual(await syncReleased(deps), { merged: [9], closed: [], open: [] });
  assert.equal(repo.getStep(step.id)!.status, "done");
  assert.ok(!existsSync(join(dir, ".worktrees", `router-step-${step.id.slice(0, 8)}`)));
});
