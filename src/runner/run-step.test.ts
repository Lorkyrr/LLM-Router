import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type Tier } from "../config.ts";
import type { Adapter, RunInput, RunResult } from "../adapters/types.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import type { Exec } from "../exec.ts";
import { AGENT_TIMEOUT_MS, CI_TIMEOUT_MS, runStep } from "./run-step.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 };
const good: RunResult = { ok: true, text: "feito", usage, cost_usd: 0.05, quota_exhausted: false };
const bad = (error: string, quota = false): RunResult => ({ ok: false, text: "", usage, cost_usd: null, quota_exhausted: quota, error });

type Ci = "green" | "red" | "conflict";
function setup(agent: RunResult[], ci: Ci[], tier: Tier = "mid", changed: boolean[] = []) {
  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "implemente x", tier, depends_on: [], files: [] });
  const runs: RunInput[] = [];
  const adapter: Adapter = {
    async run(i) {
      runs.push(i);
      return agent[Math.min(runs.length - 1, agent.length - 1)]!;
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  let statuses = 0;
  let round = 0;
  const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
  const exec = fakeExec([
    { when: (c) => a(c, "fetch"), reply: ok() },
    { when: (c) => a(c, "worktree"), reply: ok() },
    { when: (c) => a(c, "add"), reply: ok() },
    { when: (c) => a(c, "status"), reply: () => ok(changed[statuses++] === false ? "" : " M f\n") },
    { when: (c) => a(c, "commit"), reply: ok() },
    { when: (c) => a(c, "push"), reply: ok() },
    { when: (c) => c.cmd === "gh" && a(c, "pr", "create"), reply: ok("https://github.com/o/r/pull/5") },
    { when: (c) => a(c, "pr", "view"), reply: () => ok(JSON.stringify({ mergeable: ci[round++] === "conflict" ? "CONFLICTING" : "MERGEABLE" })) },
    { when: (c) => a(c, "pr", "checks"), reply: () => ({ code: ci[round - 1] === "red" ? 1 : 0, stdout: "lint fail", stderr: "" }) },
    { when: (c) => a(c, "pr", "merge"), reply: ok() },
  ]);
  const deps = { cfg, adapters: { "claude-code": adapter, "grok-build": adapter }, repo, exec, repoDir: "/repo", base: "main", runner: "hosted" as const };
  return { deps, repo, step, runs, exec };
}

test("green on the first attempt: merged, step done, tokens and cost recorded", async () => {
  const s = setup([good], ["green"]);
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 1 });
  const [a] = s.repo.listAttempts(s.step.id);
  assert.equal(a!.model, "sonnet-5-5");
  assert.equal(a!.effort, "medium");
  assert.equal(a!.ci_result, "merged");
  assert.equal(a!.est_cost_usd, 0.05);
  assert.equal(a!.output_tokens, 20);
  assert.equal(s.repo.getStep(s.step.id)!.pr_number, 5);
  assert.equal(s.repo.getStep(s.step.id)!.status, "done");
});

test("red CI retries in a fresh run with higher effort and the failure in the prompt", async () => {
  const s = setup([good], ["red", "green"]);
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.equal(s.runs[1]!.effort, "high");
  assert.match(s.runs[1]!.prompt, /implemente x/);
  assert.match(s.runs[1]!.prompt, /lint fail/);
  assert.equal(s.runs[0]!.prompt, "implemente x");
  assert.equal(s.exec.calls.filter((c) => c.args[1] === "create").length, 1);
});

test("three reds stop with the branch open and the reason", async () => {
  const s = setup([good], ["red", "red", "red"]);
  const r = await runStep(s.deps, s.step.id);
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 3);
  assert.match((r as { reason: string }).reason, /lint fail/);
  assert.deepEqual(s.runs.map((x) => x.effort), ["medium", "high", "xhigh"]);
  assert.ok(!s.exec.calls.some((c) => c.args[1] === "merge"));
  assert.equal(s.repo.getStep(s.step.id)!.status, "failed");
});

test("a merge conflict counts as an attempt", async () => {
  const s = setup([good], ["conflict", "green"]);
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.equal(s.repo.listAttempts(s.step.id)[0]!.ci_result, "conflict");
});

test("exhausted quota moves to the next model of the same tier without escalating", async () => {
  const s = setup([bad("usage limit reached", true), good], ["green"], "cheap");
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.equal(s.repo.listAttempts(s.step.id)[1]!.model, "grok-fast");
  assert.equal(s.runs[1]!.effort, "low");
});

test("whole tier out of quota waits instead of dropping a tier", async () => {
  const s = setup([bad("usage limit reached", true)], [], "mid");
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "waiting_quota", attempts: 1 });
  assert.equal(s.repo.getStep(s.step.id)!.status, "waiting_quota");
});

test("an agent that changes nothing fails the attempt", async () => {
  const s = setup([good], ["green"], "mid", [false]);
  const r = await runStep(s.deps, s.step.id);
  assert.deepEqual(r, { status: "done", attempts: 2 });
  assert.match(s.repo.listAttempts(s.step.id)[0]!.failure_reason ?? "", /no changes/);
});

test("cost falls back to the price table when the CLI gives none", async () => {
  const s = setup([{ ...good, cost_usd: null }], ["green"]);
  await runStep(s.deps, s.step.id);
  assert.equal(s.repo.listAttempts(s.step.id)[0]!.est_cost_usd, (10 * 3 + 20 * 15) / 1e6);
});

test("the local runner is held only while CI runs, once per attempt", async () => {
  const s = setup([good], ["red", "green"]);
  const events: string[] = [];
  const lease = { acquire: async () => void events.push("up"), release: async () => void events.push("down") };
  await runStep({ ...s.deps, lease }, s.step.id);
  assert.deepEqual(events, ["up", "down", "up", "down"]);
});

const breakOn = (base: Exec, when: (cmd: string, args: string[]) => boolean, msg: string): Exec =>
  async (cmd, args, opts) => {
    if (when(cmd, args)) throw new Error(msg);
    return base(cmd, args, opts);
  };

test("an exception in verification releases the runner and fails the step with the attempt closed", async () => {
  const s = setup([good], ["green"]);
  const events: string[] = [];
  const lease = { acquire: async () => void events.push("up"), release: async () => void events.push("down") };
  const exec = breakOn(s.deps.exec, (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", "gh exploded");
  const r = await runStep({ ...s.deps, lease, exec }, s.step.id);
  assert.deepEqual(r, { status: "failed", attempts: 1, reason: "gh exploded" });
  assert.deepEqual(events, ["up", "down"]);
  const [a] = s.repo.listAttempts(s.step.id);
  assert.ok(a!.finished_at);
  assert.equal(a!.failure_reason, "gh exploded");
  assert.equal(a!.est_cost_usd, 0.05, "tokens already spent are still recorded");
  assert.equal(s.repo.getStep(s.step.id)!.status, "failed");
});

test("an adapter that throws fails the step and closes the attempt", async () => {
  const s = setup([good], ["green"]);
  const adapter: Adapter = { run: async () => { throw new Error("spawn EAGAIN"); }, ping: async () => ({ available: true, quota_state: "ok" }) };
  const r = await runStep({ ...s.deps, adapters: { "claude-code": adapter, "grok-build": adapter } }, s.step.id);
  assert.deepEqual(r, { status: "failed", attempts: 1, reason: "spawn EAGAIN" });
  const [a] = s.repo.listAttempts(s.step.id);
  assert.ok(a!.finished_at);
  assert.equal(a!.failure_reason, "spawn EAGAIN");
  assert.equal(s.repo.getStep(s.step.id)!.status, "failed");
});

test("exceptions from publishing or from the lease also fail the step instead of leaving it running", async () => {
  const p = setup([good], ["green"]);
  const exec = breakOn(p.deps.exec, (c, a) => c === "git" && a[0] === "push", "push denied");
  assert.deepEqual(await runStep({ ...p.deps, exec }, p.step.id), { status: "failed", attempts: 1, reason: "push denied" });
  assert.ok(p.repo.listAttempts(p.step.id)[0]!.finished_at);

  const l = setup([good], ["green"]);
  const lease = { acquire: async () => { throw new Error("runner failed to start: x"); }, release: async () => { throw new Error("must not release"); } };
  const r = await runStep({ ...l.deps, lease }, l.step.id);
  assert.equal(r.status, "failed");
  assert.ok(l.repo.listAttempts(l.step.id)[0]!.finished_at);
  assert.equal(l.repo.getStep(l.step.id)!.status, "failed");
});

test("startBranch failing marks the step failed with no branch recorded", async () => {
  const s = setup([good], ["green"]);
  const exec = breakOn(s.deps.exec, (c, a) => c === "git" && a[0] === "worktree", "worktree exists");
  const r = await runStep({ ...s.deps, exec }, s.step.id);
  assert.deepEqual(r, { status: "failed", attempts: 0, reason: "worktree exists" });
  assert.equal(s.repo.getStep(s.step.id)!.status, "failed");
  assert.equal(s.repo.getStep(s.step.id)!.branch, null);
  assert.equal(s.runs.length, 0);
});

test("a step already done is not executed again", async () => {
  const s = setup([good], ["green"]);
  assert.equal((await runStep(s.deps, s.step.id)).status, "done");
  const calls = s.exec.calls.length;
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 1 });
  assert.equal(s.exec.calls.length, calls);
  assert.equal(s.runs.length, 1);
});

test("a step that already has a branch reuses its worktree and PR and keeps attempt numbering", async () => {
  const s = setup([good], ["green"]);
  s.repo.updateStep(s.step.id, { status: "failed", branch: "router/step-abcd1234", pr_number: 5 });
  s.repo.insertAttempt({ step_id: s.step.id, n: 1, adapter: "claude-code", model: "sonnet-5-5", tier: "mid", effort: "medium", runner: "hosted" });
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.ok(!s.exec.calls.some((c) => c.args[0] === "worktree"), "no worktree add");
  assert.ok(!s.exec.calls.some((c) => c.args[1] === "create"), "no second PR");
  assert.equal(s.runs[0]!.cwd, "/repo/.worktrees/router-step-abcd1234");
  assert.deepEqual(s.repo.listAttempts(s.step.id).map((a) => a.n), [1, 2]);
});

test("the agent and the CI wait both get a timeout", async () => {
  const s = setup([good], ["green"]);
  await runStep(s.deps, s.step.id);
  assert.equal(s.runs[0]!.timeoutMs, AGENT_TIMEOUT_MS);
  assert.equal(s.exec.calls.find((c) => c.args[1] === "checks")!.opts?.timeoutMs, CI_TIMEOUT_MS);
});
