import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { chooseRunner, findOrphans } from "./dispatch.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const runners = (...labels: string[]) => ok(JSON.stringify({ runners: labels.map((l) => ({ status: "offline", labels: [{ name: l }] })) }));

test("a registered router-ci runner wins even while offline and the repo is queried through gh api", async () => {
  const exec = fakeExec([{ when: () => true, reply: runners("self-hosted", "router-ci") }]);
  assert.deepEqual(await chooseRunner(exec, cfg, { repo: "o/r", tier: "strong" }), { runner: "self_hosted", refused: false });
  assert.deepEqual(exec.calls[0]!.args, ["api", "repos/o/r/actions/runners"]);
});

test("no router-ci runner falls back to hosted, which accepts only cloud tiers", async () => {
  const exec = fakeExec([{ when: () => true, reply: runners("self-hosted") }]);
  assert.deepEqual(await chooseRunner(exec, cfg, { repo: "o/r", tier: "mid" }), { runner: "hosted", refused: false });
  assert.deepEqual(await chooseRunner(exec, cfg, { repo: "o/r", tier: "strong" }), { runner: "hosted", refused: true });
});

test("gh failure or unreadable output counts as no runner", async () => {
  assert.equal((await chooseRunner(fakeExec([{ when: () => true, reply: fail("boom") }]), cfg, { repo: "o/r", tier: "cheap" })).runner, "hosted");
  assert.equal((await chooseRunner(fakeExec([{ when: () => true, reply: ok("<html>") }]), cfg, { repo: "o/r", tier: "cheap" })).runner, "hosted");
});

test("findOrphans lists running steps whose open attempt outlived the heartbeat", () => {
  const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
  const stamp = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString();
  let clock = stamp(0);
  const repo = makeRepo(openDb(), () => clock);
  const task = repo.insertTask({ request: "r" });
  const mk = (seq: number) => repo.insertStep({ task_id: task.id, seq, brief: "b", tier: "mid", depends_on: [], files: [] });
  const attempt = (stepId: string) =>
    repo.insertAttempt({ step_id: stepId, n: 1, adapter: "claude-code", model: "m", tier: "mid", effort: "medium", runner: "hosted" });

  const stale = mk(1); // sem heartbeat há mais que o limite
  const fresh = mk(2);
  const finished = mk(3);
  const notRunning = mk(4);
  for (const s of [stale, fresh, finished]) repo.updateStep(s.id, { status: "running" });
  attempt(stale.id);
  attempt(notRunning.id);
  clock = stamp(cfg.dispatch.heartbeat_timeout_s - 10);
  attempt(fresh.id);
  const done = attempt(finished.id);
  repo.finishAttempt(done.id, {});

  const now = () => T0 + (cfg.dispatch.heartbeat_timeout_s + 1) * 1000;
  assert.deepEqual(findOrphans(repo, cfg, now, task.id), [stale.id]);
});
