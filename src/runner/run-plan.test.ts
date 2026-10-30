import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.ts";
import type { Adapter, RunResult } from "../adapters/types.ts";
import { fakeExec, ok } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { runPlan } from "./run-plan.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 };
const good: RunResult = { ok: true, text: "feito", usage, cost_usd: 0.01, quota_exhausted: false };
const bad = (quota = false): RunResult => ({ ok: false, text: "", usage, cost_usd: null, quota_exhausted: quota, error: "boom" });

function setup(agent: (brief: string) => RunResult = () => good) {
  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const mk = (seq: number, depends_on: string[] = []) =>
    repo.insertStep({ task_id: task.id, seq, brief: `passo ${seq}`, tier: "mid", depends_on, files: [] });
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const adapter: Adapter = {
    async run(i) {
      const brief = i.prompt.split("\n")[0]!;
      started.push(brief);
      maxActive = Math.max(maxActive, ++active);
      await sleep(20);
      active--;
      return agent(brief);
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
  const exec = fakeExec([
    { when: (c) => a(c, "worktree"), reply: ok() },
    { when: (c) => a(c, "add"), reply: ok() },
    { when: (c) => a(c, "status"), reply: ok(" M f\n") },
    { when: (c) => a(c, "commit"), reply: ok() },
    { when: (c) => a(c, "push"), reply: ok() },
    { when: (c) => c.cmd === "gh" && a(c, "pr", "create"), reply: ok("https://github.com/o/r/pull/5") },
    { when: (c) => a(c, "pr", "view"), reply: ok(JSON.stringify({ mergeable: "MERGEABLE" })) },
    { when: (c) => a(c, "pr", "checks"), reply: ok() },
    { when: (c) => a(c, "pr", "merge"), reply: ok() },
  ]);
  const deps = { cfg, adapters: { "claude-code": adapter, "grok-build": adapter }, repo, exec, repoDir: "/repo", base: "main", runner: "hosted" as const };
  return { deps, repo, task, mk, started, maxActive: () => maxActive };
}

test("independent steps run in parallel and the task ends done", async () => {
  const s = setup();
  s.mk(1);
  s.mk(2);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [1, 2], failed: [], blocked: [], waiting_quota: [] });
  assert.equal(s.maxActive(), 2);
  assert.equal(s.repo.getTask(s.task.id)!.status, "done");
});

test("a dependent step waits for its prerequisite to be done", async () => {
  const s = setup();
  const a = s.mk(1);
  s.mk(2, [a.id]);
  const out = await runPlan(s.deps, s.task.id);
  assert.deepEqual(out.done, [1, 2]);
  assert.deepEqual(s.started, ["passo 1", "passo 2"]);
  assert.equal(s.maxActive(), 1);
});

test("a failed prerequisite blocks dependents but not independent steps", async () => {
  const s = setup((brief) => (brief === "passo 1" ? bad() : good));
  const a = s.mk(1);
  s.mk(2, [a.id]);
  s.mk(3);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [3], failed: [1], blocked: [2], waiting_quota: [] });
  assert.ok(!s.started.includes("passo 2"));
  assert.equal(s.repo.getTask(s.task.id)!.status, "failed");
});

test("a prerequisite waiting on quota blocks dependents and parks the task", async () => {
  const s = setup(() => bad(true));
  const a = s.mk(1);
  s.mk(2, [a.id]);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [], failed: [], blocked: [2], waiting_quota: [1] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "waiting_quota");
});

test("a dependency on an unknown step is blocked instead of hanging", async () => {
  const s = setup();
  s.mk(1);
  s.mk(2, ["inexistente"]);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [1], failed: [], blocked: [2], waiting_quota: [] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "failed");
});
