import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { verifyAndMerge } from "./ci.ts";

const sub = (...s: string[]) => (c: { args: string[] }) => s.every((x, i) => c.args[i] === x);
const view = (mergeable: string) => ({ when: sub("pr", "view"), reply: ok(JSON.stringify({ mergeable })) });
const o = { cwd: "/wt", pr: 7, deleteBranch: true };

test("green checks then rebase merge, then remote branch deleted separately", async () => {
  const exec = fakeExec([
    view("MERGEABLE"),
    { when: sub("pr", "checks"), reply: ok("all good") },
    { when: sub("pr", "merge"), reply: ok() },
    { when: (c) => c.cmd === "git", reply: ok() },
  ]);
  assert.deepEqual(await verifyAndMerge(exec, { ...o, branch: "router/s1" }), { result: "merged" });
  assert.deepEqual(exec.calls.find((c) => c.args[1] === "merge")!.args, ["pr", "merge", "7", "--rebase"]);
  assert.deepEqual(exec.calls.find((c) => c.cmd === "git")!.args, ["push", "origin", "--delete", "router/s1"]);
  assert.ok(exec.calls.find((c) => c.args[1] === "checks")!.args.includes("--watch"));
});

test("deleteBranch false (or no branch) does not touch the remote", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: ok() }, { when: sub("pr", "merge"), reply: ok() }]);
  await verifyAndMerge(exec, { ...o, deleteBranch: false, branch: "b" });
  await verifyAndMerge(exec, o);
  assert.ok(!exec.calls.some((c) => c.cmd === "git"));
});

test("red checks fail with the check output as reason and never merge", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: { code: 1, stdout: "test\tfail\t1m", stderr: "" } }]);
  const r = await verifyAndMerge(exec, o);
  assert.equal(r.result, "failed");
  assert.match((r as { reason: string }).reason, /test\tfail/);
  assert.ok(!exec.calls.some((c) => c.args[1] === "merge"));
});

test("red checks append the tail of the failed job log", async () => {
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const exec = fakeExec([
    view("MERGEABLE"),
    { when: (c) => c.args.includes("--json"), reply: ok(JSON.stringify([{ bucket: "pass", link: "x/runs/1/job/2" }, { bucket: "fail", link: "https://github.com/o/r/actions/runs/555/job/9" }])) },
    { when: sub("pr", "checks"), reply: { code: 1, stdout: "test\tfail\t1m", stderr: "" } },
    { when: sub("run", "view"), reply: ok(log) },
  ]);
  const r = (await verifyAndMerge(exec, o)) as { reason: string };
  assert.match(r.reason, /^test\tfail/);
  assert.match(r.reason, /line 99/);
  assert.match(r.reason, /line 40/);
  assert.doesNotMatch(r.reason, /line 39\b/);
  assert.deepEqual(exec.calls.find((c) => c.args[0] === "run")!.args, ["run", "view", "555", "--log-failed"]);
});

test("if the failed log cannot be fetched the reason is just the checks table", async () => {
  const exec = fakeExec([
    view("MERGEABLE"),
    { when: (c) => c.args.includes("--json"), reply: ok(JSON.stringify([{ bucket: "fail", link: "x/runs/5/job/1" }])) },
    { when: sub("pr", "checks"), reply: { code: 1, stdout: "test\tfail", stderr: "" } },
    { when: sub("run", "view"), reply: fail("gone") },
  ]);
  assert.equal(((await verifyAndMerge(exec, o)) as { reason: string }).reason, "test\tfail");
});

test("a conflicting PR is reported as conflict before waiting for CI", async () => {
  const exec = fakeExec([view("CONFLICTING")]);
  const r = (await verifyAndMerge(exec, { ...o, base: "develop" })) as { result: string; reason: string };
  assert.equal(r.result, "conflict");
  assert.match(r.reason, /rebase no origin\/develop, resolva os conflitos e dê push/);
  assert.equal(exec.calls.length, 1);
});

test("merge refused for conflict text is conflict, other errors are failures", async () => {
  const base = [view("MERGEABLE"), { when: sub("pr", "checks"), reply: ok() }];
  const c = await verifyAndMerge(fakeExec([...base, { when: sub("pr", "merge"), reply: fail("Pull request is not mergeable: merge conflict") }]), o);
  assert.equal(c.result, "conflict");
  assert.match((c as { reason: string }).reason, /rebase no origin\/main/);
  const f = await verifyAndMerge(fakeExec([...base, { when: sub("pr", "merge"), reply: fail("branch protection") }]), o);
  assert.equal(f.result, "failed");
  const p = await verifyAndMerge(fakeExec([...base, { when: sub("pr", "merge"), reply: fail("Pull request is not mergeable: the base branch policy prohibits the merge") }]), o);
  assert.equal(p.result, "failed");
});

test("pending checks exit code (8) is a failure with a clear reason, not a merge", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: { code: 8, stdout: "", stderr: "" } }]);
  const r = await verifyAndMerge(exec, o);
  assert.equal(r.result, "failed");
});

test("checks not registered yet are polled again instead of failing the PR", async () => {
  let n = 0;
  const exec = fakeExec([
    view("MERGEABLE"),
    { when: sub("pr", "checks"), reply: () => (n++ < 2 ? { code: 1, stdout: "", stderr: "no checks reported on the 'b' branch" } : ok()) },
    { when: sub("pr", "merge"), reply: ok() },
  ]);
  assert.deepEqual(await verifyAndMerge(exec, { ...o, pollMs: 0 }), { result: "merged" });
  assert.equal(n, 3);
});
