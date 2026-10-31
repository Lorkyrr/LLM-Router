import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { Adapter } from "../adapters/types.ts";
import { realExec, type Exec } from "../exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { runStep } from "./run-step.ts";

// Git real com remoto bare; só o `gh` é falso (o merge dele é um push para main). Prova push-só-depois-do-gate e o rebase no remoto.
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const cfg0 = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 };

test("staged end to end: failing gate pushes nothing, passing gate pushes and the PR merges into the remote main", async () => {
  const root = mkdtempSync(join(tmpdir(), "router-staged-"));
  const remote = join(root, "remote.git");
  const dir = join(root, "work");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "clone", remote, dir);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "push", "origin", "HEAD:main");

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
  const pushesBefore: string[] = [];
  const ghCalls: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "push" && !args.includes("--delete")) pushesBefore.push(String(runs));
    if (cmd !== "gh") return realExec(cmd, args, opts);
    ghCalls.push(args.slice(0, 2).join(" "));
    if (args[1] === "create") return { code: 0, stdout: "https://github.com/o/r/pull/9", stderr: "" };
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ mergeable: "MERGEABLE" }), stderr: "" };
    if (args[1] === "merge") return realExec("git", ["push", "origin", "HEAD:main"], opts);
    return { code: 0, stdout: "", stderr: "" };
  };
  const cfg = { ...cfg0, verify: { ...cfg0.verify, mode: "staged" as const, local: { cmds: [["test", "-f", "b.txt"]], timeout_s: 60 }, auto_merge: true } };
  const out = await runStep(
    { cfg, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repo, exec, repoDir: dir, base: "main", runner: "self_hosted" },
    step.id,
  );

  assert.deepEqual(out, { status: "done", attempts: 2 });
  assert.deepEqual(repo.listAttempts(step.id).map((a) => a.ci_result), ["local_failed", "merged"]);
  assert.deepEqual(pushesBefore, ["2"]); // um só push, depois da 2ª rodada do agente
  assert.ok(ghCalls.includes("pr create") && ghCalls.includes("pr merge"));
  git(dir, "fetch", "origin", "main");
  assert.equal(git(dir, "show", "origin/main:b.txt"), "b");
  assert.equal(git(dir, "log", "-1", "--format=%s", "origin/main"), "crie b.txt");
  assert.ok(!existsSync(join(dir, ".worktrees", `router-step-${step.id.slice(0, 8)}`)));
});
