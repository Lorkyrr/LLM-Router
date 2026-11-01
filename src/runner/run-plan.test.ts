import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../config.ts";
import type { Adapter, RunResult } from "../adapters/types.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
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
    { when: (c) => a(c, "ls-remote"), reply: { code: 2, stdout: "", stderr: "" } },
    { when: (c) => ["hash-object", "mktree", "commit-tree"].some((arg) => c.args.includes(arg)), reply: ok("a".repeat(40) + "\n") },
    { when: (c) => a(c, "fetch"), reply: ok() },
    { when: (c) => a(c, "worktree"), reply: ok() },
    { when: (c) => a(c, "branch"), reply: ok() },
    { when: (c) => a(c, "add"), reply: ok() },
    { when: (c) => a(c, "status"), reply: ok(" M f\n") },
    { when: (c) => a(c, "commit"), reply: ok() },
    { when: (c) => a(c, "push"), reply: ok() },
    { when: (c) => c.cmd === "gh" && a(c, "pr", "create"), reply: ok("https://github.com/o/r/pull/5") },
    { when: (c) => a(c, "pr", "view"), reply: ok(JSON.stringify({ mergeable: "MERGEABLE" })) },
    { when: (c) => a(c, "pr", "checks"), reply: ok() },
    { when: (c) => a(c, "pr", "merge"), reply: ok() },
  ]);
  const deps = { cfg, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repo, exec, repoDir: "/repo", base: "main", runner: "hosted" as const };
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

test("run_plan backs up final history, including costs but excluding free text, without checking out a branch", async () => {
  const s = setup();
  s.mk(1);
  const secret = "SECRET-never-export";
  const other = s.repo.insertTask({ request: secret, source_channel: secret });
  const step = s.repo.insertStep({ task_id: other.id, seq: 1, brief: secret, tier: "mid", files: [secret], depends_on: [] });
  const attempt = s.repo.insertAttempt({ step_id: step.id, n: 1, adapter: "codex", model: "sol", tier: "mid", effort: "medium", runner: "hosted" });
  s.repo.finishAttempt(attempt.id, { failure_reason: secret, est_cost_usd: 0.12, input_tokens: 42 });
  s.repo.insertMessage({ direction: "in", channel: "claude", body: secret });
  await runPlan(s.deps, s.task.id);
  const calls = s.deps.exec.calls;
  const content = calls.find((c) => c.args[0] === "hash-object")?.opts?.input;
  assert.ok(content);
  assert.ok(!content.includes(secret));
  const rows = content.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.find((r) => r.type === "task" && r.id === s.task.id).status, "done");
  assert.equal(rows.find((r) => r.type === "step" && r.task_id === s.task.id).status, "done");
  assert.equal(rows.find((r) => r.id === attempt.id).est_cost_usd, 0.12);
  assert.equal(rows.find((r) => r.id === attempt.id).input_tokens, 42);
  assert.ok(calls.some((c) => c.args[0] === "push" && c.args.at(-1)?.endsWith(":refs/heads/router/state")));
  assert.ok(!calls.some((c) => ["checkout", "switch", "update-index", "read-tree"].includes(c.args[0]!)));
});

test("history backup respects never and retries after a failed publication without failing the plan", async () => {
  const s = setup();
  const never = { ...s.deps.cfg, verify: { ...s.deps.cfg.verify, push: "never" as const } };
  await runPlan({ ...s.deps, cfg: never }, s.task.id);
  assert.equal(s.deps.exec.calls.length, 0);
  let failPush = true;
  const exec = fakeExec([
    { when: (c) => c.args[0] === "push", reply: () => failPush ? fail("offline") : ok() },
    { when: () => true, reply: (c) => s.deps.exec(c.cmd, c.args, c.opts) },
  ]);
  const err = mock.method(console, "error", () => {});
  try {
    assert.deepEqual((await runPlan({ ...s.deps, exec }, s.task.id)).failed, []);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /router\/state.*próximo/);
    failPush = false;
    await runPlan({ ...s.deps, exec }, s.task.id);
    assert.equal(exec.calls.filter((c) => c.args[0] === "push").length, 2);
  } finally {
    err.mock.restore();
  }
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
  const history = s.deps.exec.calls.find((c) => c.args[0] === "hash-object")!.opts!.input!;
  assert.equal(JSON.parse(history.split("\n")[1]!).status, "failed");
});

test("a prerequisite waiting on quota blocks dependents and parks the task", async () => {
  const s = setup(() => bad(true));
  const a = s.mk(1);
  s.mk(2, [a.id]);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [], failed: [], blocked: [2], waiting_quota: [1] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "waiting_quota");
  const history = s.deps.exec.calls.find((c) => c.args[0] === "hash-object")!.opts!.input!;
  assert.equal(JSON.parse(history.split("\n")[1]!).status, "waiting_quota");
});

test("a dependency on an unknown step is blocked instead of hanging", async () => {
  const s = setup();
  s.mk(1);
  s.mk(2, ["inexistente"]);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [1], failed: [], blocked: [2], waiting_quota: [] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "failed");
});

test("steps already done are not run again and count as satisfied dependencies", async () => {
  const s = setup();
  const a = s.mk(1);
  s.mk(2, [a.id]);
  s.repo.updateStep(a.id, { status: "done" });
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [1, 2], failed: [], blocked: [], waiting_quota: [] });
  assert.deepEqual(s.started, ["passo 2"]);
});

test("failed and waiting_quota steps are resumed on a new run", async () => {
  const s = setup();
  const a = s.mk(1);
  const b = s.mk(2);
  s.repo.updateStep(a.id, { status: "failed" });
  s.repo.updateStep(b.id, { status: "waiting_quota" });
  s.repo.updateTask(s.task.id, { status: "waiting_quota" });
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [1, 2], failed: [], blocked: [], waiting_quota: [] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "done");
});

test("a second run on a task that is already running is refused without touching it", async () => {
  const s = setup();
  s.mk(1);
  const first = runPlan(s.deps, s.task.id);
  await assert.rejects(() => runPlan(s.deps, s.task.id), /already running/);
  assert.deepEqual((await first).done, [1]);
  assert.deepEqual(s.started, ["passo 1"]);
});

test("a step that throws fails alone: independent steps finish and the task ends failed", async () => {
  const s = setup((brief) => {
    if (brief === "passo 1") throw new Error("spawn EAGAIN");
    return good;
  });
  const a = s.mk(1);
  s.mk(2, [a.id]);
  s.mk(3);
  assert.deepEqual(await runPlan(s.deps, s.task.id), { done: [3], failed: [1], blocked: [2], waiting_quota: [] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "failed");
  assert.equal(s.repo.getStep(a.id)!.status, "failed");
  assert.ok(s.repo.listAttempts(a.id)[0]!.finished_at);
});

test("staged: PRs left open count as satisfied prerequisites and the task waits for the release", async () => {
  const s = setup();
  const one = s.mk(1);
  s.mk(2, [one.id]);
  const exec = fakeExec([
    { when: (c) => c.args[0] === "ls-remote", reply: { code: 2, stdout: "", stderr: "" } },
    { when: (c) => ["hash-object", "mktree", "commit-tree"].some((arg) => c.args.includes(arg)), reply: ok("a".repeat(40)) },
    { when: (c) => c.cmd === "gh" && c.args[1] === "create", reply: ok("https://github.com/o/r/pull/5") },
    { when: () => true, reply: ok(" M f\n") },
  ]);
  const staged = { ...cfg, verify: { ...cfg.verify, mode: "staged" as const, local: { cmds: [["npm", "test"]], timeout_s: 60 } } };
  const out = await runPlan({ ...s.deps, cfg: staged, exec }, s.task.id);
  assert.deepEqual(out, { done: [], failed: [], blocked: [], waiting_quota: [], pr_open: [1, 2] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "awaiting_release");
  const history = exec.calls.find((c) => c.args[0] === "hash-object")!.opts!.input!;
  assert.equal(JSON.parse(history.split("\n")[1]!).status, "awaiting_release");
  assert.equal(exec.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add" && c.args.includes("origin/router/step-" + one.id.slice(0, 8)))?.args[0], "worktree");
});
