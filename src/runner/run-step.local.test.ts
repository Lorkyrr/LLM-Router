import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { Adapter } from "../adapters/types.ts";
import { realExec } from "../exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { runStep } from "./run-step.ts";

// Git real em repositório temporário e agente falso: prova a mecânica local sem modelos pagos nem GitHub.
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const cfg0 = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 };

test("local mode end to end with real git: agent edit is tested, rebased and fast-forwarded into main", async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-local-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");

  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "crie b.txt", tier: "mid", depends_on: [], files: [] });
  const adapter: Adapter = {
    async run(i) {
      writeFileSync(join(i.cwd, "b.txt"), "b\n");
      return { ok: true, text: "feito", usage, cost_usd: 0, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const cfg = { ...cfg0, verify: { ...cfg0.verify, mode: "local" as const, test_cmd: ["test", "-f", "b.txt"], auto_merge: true } };
  const out = await runStep(
    { cfg, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repo, exec: realExec, repoDir: dir, base: "main", runner: "self_hosted" },
    step.id,
  );

  assert.deepEqual(out, { status: "done", attempts: 1 });
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "b\n");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "crie b.txt");
  assert.equal(git(dir, "branch", "--list", "router/*"), "");
  assert.ok(!existsSync(join(dir, ".worktrees", "router-step-" + step.id.slice(0, 8))));
});
