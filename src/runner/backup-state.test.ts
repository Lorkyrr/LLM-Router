import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { backupState } from "./backup-state.ts";
import type { StepDeps } from "./run-step.ts";

const parent = "a".repeat(40);
const tree = "b".repeat(40);
const commit = "c".repeat(40);
const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

function setup(o: { unchanged?: boolean; failAt?: string; throws?: boolean; missing?: boolean } = {}) {
  const repo = makeRepo(openDb(), () => "2026-11-01T00:00:00.000Z");
  repo.insertTask({ request: "secret" });
  const exec = fakeExec([
    { when: (c) => c.args.includes(o.failAt ?? "no-command"), reply: () => {
      if (o.throws) throw new Error("secret");
      return fail("secret");
    } },
    { when: (c) => c.args[0] === "ls-remote", reply: o.missing ? { code: 2, stdout: "", stderr: "" } : ok(`${parent}\trefs/heads/router/state\n`) },
    { when: (c) => c.args[0] === "hash-object", reply: ok("d".repeat(40)) },
    { when: (c) => c.args[0] === "mktree", reply: ok(tree) },
    { when: (c) => c.args[0] === "rev-parse", reply: ok(o.unchanged ? tree : "e".repeat(40)) },
    { when: (c) => c.args.includes("commit-tree"), reply: ok(commit) },
    { when: (c) => ["push", "fetch"].includes(c.args[0]!), reply: ok() },
  ]);
  // backupState só precisa destas dependências; adaptadores não são chamados.
  const deps = { cfg, repo, exec, repoDir: "/repo" } as unknown as StepDeps;
  return { deps, exec, repo };
}

test("state publication extends the remote parent with a normal push and never changes local refs/index", async () => {
  const s = setup();
  await backupState(s.deps);
  assert.deepEqual(s.exec.calls.map((c) => c.args[0]), ["ls-remote", "fetch", "hash-object", "mktree", "rev-parse", "-c", "push"]);
  assert.deepEqual(s.exec.calls[1]!.args, ["fetch", "--no-write-fetch-head", "origin", parent]);
  const args = s.exec.calls.find((c) => c.args.includes("commit-tree"))!.args;
  assert.deepEqual(args.slice(args.indexOf("commit-tree")), ["commit-tree", tree, "-p", parent, "-m", "backup: router history"]);
  assert.deepEqual(s.exec.calls.at(-1)!.args, ["push", "origin", `${commit}:refs/heads/router/state`]);
  assert.ok(s.exec.calls.every((c) => c.opts?.cwd === "/repo" && c.opts.timeoutMs === 60_000));
});

test("first export creates a root commit and identical history does not create another commit", async () => {
  const first = setup({ missing: true });
  await backupState(first.deps);
  assert.ok(!first.exec.calls.some((c) => c.args[0] === "fetch"));
  assert.ok(!first.exec.calls.find((c) => c.args.includes("commit-tree"))!.args.includes("-p"));
  const same = setup({ unchanged: true });
  await backupState(same.deps);
  assert.ok(!same.exec.calls.some((c) => c.args.includes("commit-tree") || c.args[0] === "push"));
  assert.equal(same.repo.exportHistory(), same.repo.exportHistory());
});

test("network, object and push failures only warn, omit command output and allow the next backup", async () => {
  const err = mock.method(console, "error", () => {});
  try {
    for (const failAt of ["ls-remote", "fetch", "hash-object", "mktree", "commit-tree", "push"]) {
      for (const throws of [false, true]) {
        const s = setup({ failAt, throws });
        await backupState(s.deps);
        assert.ok(!s.exec.calls.some((c) => c.args[0] === "push") || failAt === "push");
      }
    }
    assert.equal(err.mock.calls.length, 12);
    assert.ok(err.mock.calls.every((c) => !String(c.arguments[0]).includes("secret")));
    const next = setup();
    await backupState(next.deps);
    assert.equal(next.exec.calls.at(-1)!.args[0], "push");
  } finally {
    err.mock.restore();
  }
});

test("concurrent backups are serialized and snapshot the database when publication starts", async () => {
  const s = setup({ missing: true });
  const count = s.repo.exportHistory().trim().split("\n").length;
  const first = backupState(s.deps);
  s.repo.insertTask({ request: "another secret" });
  await Promise.all([first, backupState(s.deps)]);
  const calls = s.exec.calls;
  const lookups = calls.flatMap((c, i) => c.args[0] === "ls-remote" ? [i] : []);
  const pushes = calls.flatMap((c, i) => c.args[0] === "push" ? [i] : []);
  assert.ok(lookups[1]! > pushes[0]!);
  assert.ok(calls.filter((c) => c.args[0] === "hash-object").every((c) => c.opts!.input!.trim().split("\n").length === count + 1));
});
