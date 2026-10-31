import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { startBranch, publishBranch, commitAll } from "./branch.ts";

const is = (cmd: string, ...sub: string[]) => (c: { cmd: string; args: string[] }) =>
  c.cmd === cmd && sub.every((s, i) => c.args[i] === s);

test("startBranch creates a worktree on a new branch off the base", async () => {
  const exec = fakeExec([{ when: is("git"), reply: ok() }]);
  const wt = await startBranch(exec, { repoDir: "/repo", branch: "router/step-1", base: "main" });
  assert.equal(wt, "/repo/.worktrees/router-step-1");
  assert.deepEqual(exec.calls[0]!.args, ["fetch", "origin", "main"]);
  assert.deepEqual(exec.calls[1]!.args, ["worktree", "add", "-b", "router/step-1", wt, "origin/main"]);
  assert.ok(exec.calls.every((c) => c.opts?.cwd === "/repo"));
});

test("startBranch throws with git's message on failure", async () => {
  const exec = fakeExec([{ when: is("git", "fetch"), reply: ok() }, { when: is("git", "worktree"), reply: fail("já existe") }]);
  await assert.rejects(() => startBranch(exec, { repoDir: "/repo", branch: "b", base: "main" }), /já existe/);
});

test("publishBranch commits, pushes and opens the PR, returning its number", async () => {
  const exec = fakeExec([
    { when: is("git", "add"), reply: ok() },
    { when: is("git", "status"), reply: ok(" M src/a.ts\n") },
    { when: is("git", "commit"), reply: ok() },
    { when: is("git", "push"), reply: ok() },
    { when: is("gh", "pr", "create"), reply: ok("https://github.com/o/r/pull/42\n") },
  ]);
  const r = await publishBranch(exec, { worktree: "/wt", branch: "b", base: "main", title: "t", body: "corpo" });
  assert.deepEqual(r, { changed: true, pr_number: 42 });
  assert.deepEqual(exec.calls.find((c) => c.args[0] === "push")!.args, ["push", "-u", "--force-with-lease", "origin", "b"]);
  const create = exec.calls.find((c) => c.cmd === "gh")!;
  for (const [flag, v] of [["--title", "t"], ["--body", "corpo"], ["--base", "main"], ["--head", "b"]]) {
    assert.equal(create.args[create.args.indexOf(flag!) + 1], v);
  }
  assert.ok(exec.calls.every((c) => c.opts?.cwd === "/wt"));
});

test("publishBranch with no changes does not commit, push or open a PR", async () => {
  const exec = fakeExec([
    { when: is("git", "add"), reply: ok() },
    { when: is("git", "status"), reply: ok("") },
  ]);
  const r = await publishBranch(exec, { worktree: "/wt", branch: "b", base: "main", title: "t", body: "" });
  assert.deepEqual(r, { changed: false });
  assert.equal(exec.calls.length, 2);
});

test("publishBranch surfaces a failing push", async () => {
  const exec = fakeExec([
    { when: is("git", "add"), reply: ok() },
    { when: is("git", "status"), reply: ok(" M a\n") },
    { when: is("git", "commit"), reply: ok() },
    { when: is("git", "push"), reply: fail("sem permissão") },
  ]);
  await assert.rejects(() => publishBranch(exec, { worktree: "/wt", branch: "b", base: "main", title: "t", body: "" }), /sem permissão/);
});

test("publishBranch on an existing PR pushes the new commit and reuses the number", async () => {
  const exec = fakeExec([
    { when: is("git", "add"), reply: ok() },
    { when: is("git", "status"), reply: ok(" M a\n") },
    { when: is("git", "commit"), reply: ok() },
    { when: is("git", "push"), reply: ok() },
  ]);
  const r = await publishBranch(exec, { worktree: "/wt", branch: "b", base: "main", title: "t", body: "", pr_number: 9 });
  assert.deepEqual(r, { changed: true, pr_number: 9 });
  assert.ok(!exec.calls.some((c) => c.cmd === "gh"));
});

test("startBranch in local mode skips the fetch and branches off the local base", async () => {
  const e = fakeExec([{ when: () => true, reply: ok() }]);
  await startBranch(e, { repoDir: "/r", branch: "router/step-1", base: "main", local: true });
  assert.deepEqual(e.calls.map((c) => c.args[0]), ["worktree"]);
  assert.equal(e.calls[0]!.args.at(-1), "main");
});

test("commitAll commits when there are changes and reports false when there are none", async () => {
  let dirty = " M f\n";
  const e = fakeExec([{ when: (c) => c.args[0] === "status", reply: () => ok(dirty) }, { when: () => true, reply: ok() }]);
  assert.equal(await commitAll(e, { worktree: "/w", title: "t" }), true);
  assert.ok(e.calls.some((c) => c.args[0] === "commit"));
  dirty = "";
  e.calls.length = 0;
  assert.equal(await commitAll(e, { worktree: "/w", title: "t" }), false);
  assert.ok(!e.calls.some((c) => c.args[0] === "commit"));
});
