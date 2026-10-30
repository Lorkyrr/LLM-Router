import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { verifyAndMerge } from "./ci.ts";

const sub = (...s: string[]) => (c: { args: string[] }) => s.every((x, i) => c.args[i] === x);
const view = (mergeable: string) => ({ when: sub("pr", "view"), reply: ok(JSON.stringify({ mergeable })) });
const o = { cwd: "/wt", pr: 7, deleteBranch: true };

test("green checks then rebase merge with branch deleted", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: ok("all good") }, { when: sub("pr", "merge"), reply: ok() }]);
  assert.deepEqual(await verifyAndMerge(exec, o), { result: "merged" });
  const merge = exec.calls.find((c) => c.args[1] === "merge")!;
  assert.deepEqual(merge.args, ["pr", "merge", "7", "--rebase", "--delete-branch"]);
  assert.ok(exec.calls.find((c) => c.args[1] === "checks")!.args.includes("--watch"));
});

test("deleteBranch false omits the flag", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: ok() }, { when: sub("pr", "merge"), reply: ok() }]);
  await verifyAndMerge(exec, { ...o, deleteBranch: false });
  assert.ok(!exec.calls.find((c) => c.args[1] === "merge")!.args.includes("--delete-branch"));
});

test("red checks fail with the check output as reason and never merge", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: { code: 1, stdout: "test\tfail\t1m", stderr: "" } }]);
  const r = await verifyAndMerge(exec, o);
  assert.equal(r.result, "failed");
  assert.match((r as { reason: string }).reason, /test\tfail/);
  assert.ok(!exec.calls.some((c) => c.args[1] === "merge"));
});

test("a conflicting PR is reported as conflict before waiting for CI", async () => {
  const exec = fakeExec([view("CONFLICTING")]);
  assert.equal((await verifyAndMerge(exec, o)).result, "conflict");
  assert.equal(exec.calls.length, 1);
});

test("merge refused for conflict text is conflict, other errors are failures", async () => {
  const base = [view("MERGEABLE"), { when: sub("pr", "checks"), reply: ok() }];
  const c = await verifyAndMerge(fakeExec([...base, { when: sub("pr", "merge"), reply: fail("Pull request is not mergeable: merge conflict") }]), o);
  assert.equal(c.result, "conflict");
  const f = await verifyAndMerge(fakeExec([...base, { when: sub("pr", "merge"), reply: fail("branch protection") }]), o);
  assert.equal(f.result, "failed");
});

test("pending checks exit code (8) is a failure with a clear reason, not a merge", async () => {
  const exec = fakeExec([view("MERGEABLE"), { when: sub("pr", "checks"), reply: { code: 8, stdout: "", stderr: "" } }]);
  const r = await verifyAndMerge(exec, o);
  assert.equal(r.result, "failed");
});
