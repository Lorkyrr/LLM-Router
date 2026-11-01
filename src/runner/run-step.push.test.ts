import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import type { Adapter, RunResult } from "../adapters/types.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { runStep } from "./run-step.ts";

const cfg0 = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 };
const good: RunResult = { ok: true, text: "", usage, cost_usd: 0, quota_exhausted: false };
const bad: RunResult = { ok: false, text: "", usage, cost_usd: null, quota_exhausted: false, error: "boom" };

type Opts = { push?: "always" | "never"; autoMerge?: boolean; deleteBranch?: boolean; pushOk?: boolean; agent?: RunResult[]; checks?: number[] };

// Modo local com git fake: nada de rede nem modelo pago. `checks` = exit codes sucessivos do comando de teste.
function setup(o: Opts = {}) {
  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "r" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "implemente x", tier: "mid", depends_on: [], files: [] });
  const agent = o.agent ?? [good];
  let runs = 0;
  let checks = 0;
  const adapter: Adapter = {
    async run() {
      return agent[Math.min(runs++, agent.length - 1)]!;
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const a = (c: { args: string[] }, ...s: string[]) => s.every((x, i) => c.args[i] === x);
  const exec = fakeExec([
    { when: (c) => c.cmd === "check", reply: () => ({ code: (o.checks ?? [0])[Math.min(checks++, (o.checks ?? [0]).length - 1)]!, stdout: "", stderr: "" }) },
    { when: (c) => a(c, "push"), reply: o.pushOk === false ? fail("no network") : ok() },
    { when: (c) => a(c, "status"), reply: ok(" M f\n") },
    { when: (c) => a(c, "rev-parse"), reply: ok("main\n") },
    { when: (c) => ["worktree", "add", "commit", "rebase", "merge", "branch"].includes(c.args[0]!), reply: ok() },
  ]);
  const cfg = {
    ...cfg0,
    verify: {
      ...cfg0.verify, mode: "local" as const, local: { cmds: [["check"]], timeout_s: 60 },
      auto_merge: o.autoMerge ?? true, delete_branch: o.deleteBranch ?? true, push: o.push ?? ("always" as const),
    },
  };
  const deps = { cfg, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repo, exec, repoDir: "/repo", base: "main", runner: "self_hosted" as const };
  const pushes = () => exec.calls.filter((c) => c.args[0] === "push").map((c) => c.args.join(" "));
  return { deps, step, pushes, exec };
}

const quiet = () => mock.method(console, "error", () => {});

test("local mode publishes the branch on creation and after the attempt, then deletes the remote on merge", async () => {
  const s = setup();
  const branch = `router/step-${s.step.id.slice(0, 8)}`;
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 1 });
  const push = `push -u --force-with-lease origin ${branch}`;
  assert.deepEqual(s.pushes(), [push, push, `push origin --delete ${branch}`]);
});

test("a failing attempt is pushed too, so no work stays only on this machine", async () => {
  const s = setup({ checks: [1, 0] });
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.equal(s.pushes().filter((p) => p.startsWith("push -u")).length, 3); // criação + 2 tentativas
});

test("a crashed agent run commits and pushes its partial work", async () => {
  const s = setup({ agent: [bad, good] });
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  assert.equal(s.exec.calls.filter((c) => c.args[0] === "commit").length, 2);
  assert.equal(s.pushes().filter((p) => p.startsWith("push -u")).length, 3);
});

test("push failure only warns: the step still finishes and the next push is attempted", async () => {
  const err = quiet();
  const s = setup({ pushOk: false });
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 1 });
  assert.equal(s.pushes().length, 3);
  const msgs = err.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(msgs.length, 3);
  assert.match(msgs[0]!, /push de router\/step-\w+ para origin falhou.*no network/);
  assert.match(msgs[2]!, /apagar router\/step-\w+ em origin falhou/);
  err.mock.restore();
});

test("without a merge (auto_merge off) or with delete_branch off the remote branch is kept", async () => {
  for (const o of [{ autoMerge: false }, { deleteBranch: false }]) {
    const s = setup(o);
    assert.equal((await runStep(s.deps, s.step.id)).status, "done");
    assert.ok(s.pushes().length >= 2 && s.pushes().every((p) => !p.includes("--delete")), JSON.stringify(o));
  }
});

test("verify.push never does not touch the remote", async () => {
  const s = setup({ push: "never" });
  assert.equal((await runStep(s.deps, s.step.id)).status, "done");
  assert.deepEqual(s.pushes(), []);
});
