import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../test/fixtures/fake-exec.ts";
import { overlaps, release } from "./release.ts";

const o = { cwd: "/repo", base: "main", prefix: "router/", ciCmd: ["bash", "ci/pr-ci.sh"], tmpDir: "/tmp/x" };
const list = (prs: { n: number; b: string; f: string[] }[]) =>
  ok(JSON.stringify(prs.map((p) => ({ number: p.n, headRefName: p.b, files: p.f.map((path) => ({ path })) }))));
const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
type Opt = { ci?: (wt: string) => number; rebase?: (wt: string) => boolean; ancestor?: (x: string, y: string) => boolean; merge?: (pr: string) => boolean };
function exec(prs: Parameters<typeof list>[0], opt: Opt = {}) {
  return fakeExec([
    { when: (c) => a(c, "pr", "list"), reply: list(prs) },
    { when: (c) => a(c, "fetch"), reply: ok() },
    { when: (c) => a(c, "merge-base"), reply: (c) => ({ code: opt.ancestor?.(c.args[2]!, c.args[3]!) ? 0 : 1, stdout: "", stderr: "" }) },
    { when: (c) => a(c, "worktree"), reply: ok() },
    { when: (c) => a(c, "rebase", "--abort"), reply: ok() },
    { when: (c) => a(c, "rebase"), reply: (c) => (opt.rebase?.(c.opts!.cwd!) === false ? fail("CONFLICT") : ok()) },
    { when: (c) => c.cmd === "bash", reply: (c) => ({ code: opt.ci?.(c.opts!.cwd!) ?? 0, stdout: "not ok 1", stderr: "" }) },
    { when: (c) => a(c, "pr", "comment"), reply: ok() },
    { when: (c) => a(c, "pr", "merge"), reply: (c) => (opt.merge?.(c.args[2]!) === false ? fail("not mergeable") : ok()) },
    { when: (c) => a(c, "push"), reply: ok() },
  ]);
}

test("overlaps reports files touched by more than one PR", () => {
  assert.deepEqual(
    overlaps([{ number: 1, headRefName: "a", files: ["x", "y"] }, { number: 2, headRefName: "b", files: ["y", "z"] }, { number: 3, headRefName: "c", files: ["y"] }]),
    [{ file: "y", prs: [1, 2, 3] }],
  );
});

test("only router/ PRs are released, in PR order; green ones are merged and their branches deleted", async () => {
  const e = exec([{ n: 9, b: "router/step-b", f: ["b"] }, { n: 3, b: "feature/mine", f: ["m"] }, { n: 5, b: "router/step-a", f: ["a"] }]);
  const out = await release(e, o);
  assert.deepEqual(out.merged, [5, 9]);
  assert.deepEqual(e.calls.filter((c) => a(c, "pr", "merge")).map((c) => c.args[2]), ["5", "9"]);
  assert.deepEqual(e.calls.filter((c) => a(c, "push")).map((c) => c.args.at(-1)), ["router/step-a", "router/step-b"]);
  assert.ok(e.calls.some((c) => c.args[0] === "rebase" && c.args[1] === "origin/main"));
  assert.ok(!e.calls.some((c) => c.args.includes("3")));
});

test("a red CI leaves the PR open with a comment and does not stop independent PRs", async () => {
  const e = exec([{ n: 1, b: "router/a", f: [] }, { n: 2, b: "router/b", f: [] }], { ci: (wt) => (wt.endsWith("pr-1") ? 1 : 0) });
  const out = await release(e, o);
  assert.deepEqual(out.merged, [2]);
  assert.equal(out.failed[0]!.pr, 1);
  assert.match(out.failed[0]!.reason, /\$ bash ci\/pr-ci.sh \(exit 1\)\nnot ok 1/);
  const comment = e.calls.find((c) => a(c, "pr", "comment"))!;
  assert.match(comment.opts!.input!, /not ok 1/);
  assert.ok(!e.calls.some((c) => a(c, "pr", "merge") && c.args[2] === "1"));
});

test("a PR stacked on one that was not merged is skipped instead of dragging its commits to main", async () => {
  const e = exec([{ n: 1, b: "router/a", f: [] }, { n: 2, b: "router/b", f: [] }], {
    ci: (wt) => (wt.endsWith("pr-1") ? 1 : 0),
    ancestor: (x, y) => x === "origin/router/a" && y === "origin/router/b",
  });
  const out = await release(e, o);
  assert.deepEqual(out.merged, []);
  assert.match(out.skipped[0]!.reason, /stacked on #1/);
});

test("a rebase conflict aborts the rebase, is reported as conflict and the worktree is removed", async () => {
  const e = exec([{ n: 1, b: "router/a", f: [] }], { rebase: () => false });
  const out = await release(e, o);
  assert.deepEqual(out.conflict, [1]);
  assert.ok(e.calls.some((c) => a(c, "rebase", "--abort")));
  assert.ok(e.calls.some((c) => a(c, "worktree", "remove")));
  assert.ok(!e.calls.some((c) => c.cmd === "bash"));
});

test("a refused merge is a failure and keeps the remote branch", async () => {
  const e = exec([{ n: 1, b: "router/a", f: [] }], { merge: () => false });
  const out = await release(e, o);
  assert.match(out.failed[0]!.reason, /not mergeable/);
  assert.ok(!e.calls.some((c) => a(c, "push")));
});

test("the overlap report is part of the outcome", async () => {
  const out = await release(exec([{ n: 1, b: "router/a", f: ["x"] }, { n: 2, b: "router/b", f: ["x"] }]), o);
  assert.deepEqual(out.overlaps, [{ file: "x", prs: [1, 2] }]);
});
