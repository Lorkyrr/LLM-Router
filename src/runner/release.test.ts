import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { dispatchRelease, syncReleased } from "./release.ts";

const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
function setup(states: Record<number, string>, opt: { dispatch?: "ok" | "fail"; runs?: string } = {}) {
  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const mk = (seq: number, pr: number) => {
    const s = repo.insertStep({ task_id: task.id, seq, brief: "b", tier: "mid", depends_on: [], files: [] });
    repo.updateStep(s.id, { status: "pr_open", pr_number: pr, branch: `router/step-${pr}` });
    return s;
  };
  const steps = [mk(1, 11), mk(2, 12)];
  const log: string[] = [];
  const exec = fakeExec([
    { when: (c) => a(c, "workflow", "run"), reply: () => (opt.dispatch === "fail" ? fail("no workflow") : ok()) },
    { when: (c) => a(c, "run", "list"), reply: () => ok(opt.runs ?? JSON.stringify([{ databaseId: 77, createdAt: new Date().toISOString() }])) },
    { when: (c) => a(c, "run", "watch"), reply: ok() },
    { when: (c) => a(c, "pr", "view"), reply: (c) => ok(`${states[Number(c.args[2])] ?? "OPEN"}\n`) },
    { when: () => true, reply: ok() },
  ]);
  const lease = { acquire: async () => void log.push("up"), release: async () => void log.push("down") };
  return { repo, task, steps, exec, log, d: { exec, repo, repoDir: "/repo", base: "main", lease } };
}

test("release dispatches the workflow, holds the runner while it runs and then syncs the merged PRs", async () => {
  const s = setup({ 11: "MERGED", 12: "MERGED" });
  const { prs, done } = await dispatchRelease(s.d, { pollMs: 0 });
  assert.deepEqual(prs, [11, 12]);
  await done;
  assert.deepEqual(s.exec.calls.find((c) => a(c, "workflow", "run"))!.args, ["workflow", "run", "router-release.yml", "--ref", "main"]);
  assert.ok(s.exec.calls.some((c) => a(c, "run", "watch") && c.args[2] === "77" && c.args.includes("--exit-status")));
  assert.deepEqual(s.log, ["up", "down"]);
  assert.deepEqual(s.steps.map((x) => s.repo.getStep(x.id)!.status), ["done", "done"]);
  assert.equal(s.repo.getTask(s.task.id)!.status, "done");
  assert.ok(s.exec.calls.some((c) => a(c, "branch", "-D") && c.args[2] === "router/step-11"));
});

test("PRs the workflow left open stay pr_open and the task keeps waiting; closed PRs fail the step", async () => {
  const s = setup({ 11: "MERGED", 12: "OPEN" });
  const r = await syncReleased(s.d);
  assert.deepEqual(r, { merged: [11], closed: [], open: [12] });
  assert.equal(s.repo.getTask(s.task.id)!.status, "awaiting_release");
  const c = setup({ 11: "CLOSED", 12: "MERGED" });
  assert.deepEqual((await syncReleased(c.d)).closed, [11]);
  assert.equal(c.repo.getTask(c.task.id)!.status, "failed");
});

test("nothing to release is an error and does not start the runner", async () => {
  const s = setup({});
  for (const st of s.steps) s.repo.updateStep(st.id, { status: "done" });
  await assert.rejects(dispatchRelease(s.d), /nothing to release/);
  assert.deepEqual(s.log, []);
});

test("a failed dispatch releases the runner and reports the error", async () => {
  const s = setup({}, { dispatch: "fail" });
  await assert.rejects(dispatchRelease(s.d), /no workflow/);
  assert.deepEqual(s.log, ["up", "down"]);
});

test("a workflow run that never shows up still releases the runner and syncs", async () => {
  const s = setup({ 11: "MERGED", 12: "MERGED" }, { runs: "[]" });
  const { done } = await dispatchRelease(s.d, { pollMs: 0 });
  await done;
  assert.deepEqual(s.log, ["up", "down"]);
  assert.ok(!s.exec.calls.some((c) => a(c, "run", "watch")));
});
