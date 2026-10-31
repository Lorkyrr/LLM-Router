import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { runLocalChecks, verifyLocal } from "./local.ts";

const o = { worktree: "/repo/.worktrees/b", repoDir: "/repo", branch: "router/step-1", base: "main", cmds: [["npm", "test"]], autoMerge: true };
const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
function exec(over: { tests?: ReturnType<typeof ok>; head?: string; rebase?: ReturnType<typeof ok>; merge?: ReturnType<typeof ok> } = {}) {
  return fakeExec([
    { when: (c) => c.cmd === "npm", reply: over.tests ?? ok("pass") },
    { when: (c) => a(c, "rev-parse"), reply: ok(`${over.head ?? "main"}\n`) },
    { when: (c) => a(c, "rebase", "--abort"), reply: ok() },
    { when: (c) => a(c, "rebase"), reply: over.rebase ?? ok() },
    { when: (c) => a(c, "merge"), reply: over.merge ?? ok() },
  ]);
}
const git = (e: ReturnType<typeof exec>) => e.calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));

test("green tests: rebase on base in the worktree, then fast-forward base in the repo", async () => {
  const e = exec();
  assert.deepEqual(await verifyLocal(e, o), { result: "merged" });
  assert.deepEqual(e.calls[0]!.args, ["test"]);
  assert.equal(e.calls[0]!.opts?.cwd, o.worktree);
  assert.deepEqual(git(e), ["rev-parse --abbrev-ref HEAD", "rebase main", "merge --ff-only router/step-1"]);
  assert.equal(e.calls.find((c) => a(c, "merge"))!.opts?.cwd, "/repo");
});

test("red tests fail with the output tail and never touch git", async () => {
  const e = exec({ tests: { code: 1, stdout: "not ok 1 - boom", stderr: "" } });
  const v = await verifyLocal(e, o);
  assert.equal(v.result, "failed");
  assert.match((v as { reason: string }).reason, /not ok 1 - boom/);
  assert.deepEqual(git(e), []);
});

test("auto_merge off: tests green leaves the branch for review", async () => {
  const e = exec();
  assert.deepEqual(await verifyLocal(e, { ...o, autoMerge: false }), { result: "passed" });
  assert.deepEqual(git(e), []);
});

test("repo checked out on another branch is refused instead of merging into it", async () => {
  const e = exec({ head: "feature/x" });
  const v = await verifyLocal(e, o);
  assert.equal(v.result, "failed");
  assert.match((v as { reason: string }).reason, /checkout main/);
  assert.ok(!git(e).some((c) => c.startsWith("merge")));
});

test("rebase conflict aborts the rebase and reports a conflict", async () => {
  const e = exec({ rebase: fail("CONFLICT (content)") });
  const v = await verifyLocal(e, o);
  assert.equal(v.result, "conflict");
  assert.ok(git(e).includes("rebase --abort"));
  assert.ok(!git(e).some((c) => c.startsWith("merge")));
});

test("a refused fast-forward (e.g. dirty files in the repo) is a failure with git's reason", async () => {
  const v = await verifyLocal(exec({ merge: fail("would be overwritten") }), o);
  assert.equal(v.result, "failed");
  assert.match((v as { reason: string }).reason, /would be overwritten/);
});

test("runLocalChecks runs the commands in order and stops at the first failure, naming it", async () => {
  const e = fakeExec([
    { when: (c) => c.cmd === "tsc", reply: ok() },
    { when: (c) => c.cmd === "npm", reply: { code: 2, stdout: "boom", stderr: "" } },
    { when: (c) => c.cmd === "never", reply: ok() },
  ]);
  const v = await runLocalChecks(e, { worktree: "/w", cmds: [["tsc"], ["npm", "test"], ["never"]] });
  assert.equal(v.result, "failed");
  assert.match((v as { reason: string }).reason, /^\$ npm test \(exit 2\)\nboom/);
  assert.deepEqual(e.calls.map((c) => c.cmd), ["tsc", "npm"]);
  assert.deepEqual(await runLocalChecks(fakeExec([{ when: () => true, reply: ok() }]), { worktree: "/w", cmds: [["a"], ["b"]] }), { result: "passed" });
});
