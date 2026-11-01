import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import type { Adapter, RunInput, RunResult } from "../adapters/types.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { runStep } from "./run-step.ts";
import type { Exec } from "../exec.ts";

const initial = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const good: RunResult = { ok: true, text: "done", usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, quota_exhausted: false };
const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function setup(errors: string[], options: { max?: number; budget?: number; changed?: boolean[]; diff?: string; agent?: RunResult[]; enabled?: boolean; mode?: "local" | "staged" | "pr"; push?: "always" | "never" } = {}) {
  const repo = makeRepo(openDb());
  const task = repo.insertTask({ request: "private original request", phase: "implementing" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "ORIGINAL TASK DO NOT REPEAT", tier: "mid", depends_on: [], files: ["src/a.ts"] });
  const runs: RunInput[] = [];
  const adapter: Adapter = {
    async run(input) { runs.push(input); return options.agent?.[runs.length - 1] ?? good; },
    async ping() { return { available: true, quota_state: "ok" }; },
  };
  let gates = 0;
  let statuses = 0;
  const exec = fakeExec([
    { when: c => c.cmd === "git" && c.args[0] === "diff", reply: ok(options.diff ?? diff) },
    { when: c => c.cmd === "git" && c.args[0] === "status", reply: () => ok(options.changed?.[statuses++] === false ? "" : " M src/a.ts") },
    { when: c => c.cmd === "git", reply: ok() },
    { when: c => c.cmd === "npm" || (c.cmd === "gh" && c.args.includes("--watch")), reply: () => errors[gates] ? fail(errors[gates++]!) : ok() },
    { when: c => c.cmd === "gh" && c.args[1] === "view", reply: ok('{"mergeable":"MERGEABLE"}') },
    { when: c => c.cmd === "gh" && c.args[1] === "create", reply: ok("https://github.com/o/r/pull/7") },
    { when: c => c.cmd === "gh" && c.args[1] === "checks" && c.args.includes("--json"), reply: { code: 1, stdout: '[{"bucket":"fail","link":""}]', stderr: "" } },
    { when: c => c.cmd === "gh", reply: ok("[]") },
  ]);
  const cfg = { ...initial, repair: { ...initial.repair, enabled: options.enabled ?? true, max: options.max ?? 1 },
    escalation: { ...initial.escalation, max_attempts: options.budget ?? 6 },
    verify: { ...initial.verify, mode: options.mode ?? "local", local: { cmds: [["npm", "test"]], timeout_s: 60 }, auto_merge: false, push: options.push ?? "never" } };
  return { repo, step, runs, exec, deps: { cfg, repo, exec, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter }, repoDir: "/repo", base: "main", runner: "hosted" as const } };
}

test("simple gate failure repairs in cheap low with only error and branch diff in the same worktree", async () => {
  const s = setup(["src/a.ts(1,2): error TS2304: Cannot find name 'x'."]);
  assert.deepEqual(await runStep(s.deps, s.step.id), { status: "done", attempts: 2 });
  const attempts = s.repo.listAttempts(s.step.id);
  assert.deepEqual(attempts.map(a => [a.kind, a.tier, a.effort]), [["task", "mid", "medium"], ["repair", "cheap", "low"]]);
  assert.match(attempts[1]!.reason!, /simple/);
  assert.match(s.runs[1]!.prompt, /TS2304/);
  assert.ok(s.runs[1]!.prompt.includes(diff));
  assert.doesNotMatch(s.runs[1]!.prompt, /ORIGINAL TASK|private original request/);
  assert.equal(s.runs[1]!.cwd, s.runs[0]!.cwd);
  assert.equal(attempts[1]!.input_tokens, 10);
});

test("complex gate failure repairs with the same tier and effort", async () => {
  const s = setup(["integration: deadlock between concurrent writers"]);
  await runStep(s.deps, s.step.id);
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.tier, a.effort]), [["task", "mid", "medium"], ["repair", "mid", "medium"]]);
  assert.match(s.repo.listAttempts(s.step.id)[1]!.reason!, /complex/);
});

for (const [diagnostic, tier, effort] of [["integration: deadlock", "strong", "medium"], ["SyntaxError: unexpected token", "cheap", "low"]] as const) {
  test(`per-item routing preserves ${tier} repair policy and explicit effort`, async () => {
    const s = setup([diagnostic]);
    const item = s.repo.insertStep({ task_id: s.step.task_id, seq: 2, brief: "integre contratos", tier: "strong", phase: "integration", effort: "medium", depends_on: [], files: [] });
    assert.deepEqual(await runStep(s.deps, item.id), { status: "done", attempts: 2 });
    assert.equal(s.runs[0]!.model, "gpt-6-astra");
    assert.deepEqual(s.repo.listAttempts(item.id).map(a => [a.kind, a.tier, a.effort]), [["task", "strong", "medium"], ["repair", tier, effort]]);
    assert.equal(s.runs[1]!.effort, effort);
  });
}

test("failed repair returns to the original tier ladder and brief", async () => {
  const s = setup(["SyntaxError: unexpected token", "SyntaxError: unexpected token"]);
  await runStep(s.deps, s.step.id);
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.model]), [["task", "gpt-6.1-sol"], ["repair", "haiku-5-5"], ["task", "sonnet-5-5"]]);
  assert.match(s.runs[2]!.prompt, /ORIGINAL TASK/);
});

test("no changes bypasses repair and uses the ladder", async () => {
  const s = setup([], { changed: [false, true] });
  await runStep(s.deps, s.step.id);
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.tier]), [["task", "mid"], ["task", "mid"]]);
  assert.equal(s.exec.calls.filter(c => c.args[0] === "diff").length, 0);
});

test("a repair making no changes returns to the ladder even with repairs left", async () => {
  const s = setup(["SyntaxError: unexpected token"], { max: 2, changed: [true, false, true] });
  await runStep(s.deps, s.step.id);
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => a.kind), ["task", "repair", "task"]);
});

test("repeated simple repairs raise effort to medium and consume max_attempts", async () => {
  const s = setup(["error TS2322: wrong type", "error TS2322: wrong type", "error TS2322: wrong type"], { max: 2, budget: 3 });
  assert.equal((await runStep(s.deps, s.step.id)).status, "failed");
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.effort]), [["task", "medium"], ["repair", "low"], ["repair", "medium"]]);
});

test("quota fallback stays in the repair tier and does not consume the repair limit", async () => {
  const s = setup(["error TS2322: wrong type"], { agent: [good, { ...good, ok: false, quota_exhausted: true }, good] });
  assert.equal((await runStep(s.deps, s.step.id)).status, "done");
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.tier, a.effort]), [["task", "mid", "medium"], ["repair", "cheap", "low"], ["repair", "cheap", "low"]]);
});

test("quota fallback receives the current diff including partial repair edits", async () => {
  const s = setup(["error TS2322: wrong type"], { push: "always", agent: [good, { ...good, ok: false, quota_exhausted: true }, good] });
  const exec: Exec = async (cmd, args, opts) => cmd === "git" && args[0] === "diff"
    ? ok(s.runs.length >= 2 ? `${diff}+partial repair edit\n` : diff) : s.exec(cmd, args, opts);
  assert.equal((await runStep({ ...s.deps, exec }, s.step.id)).status, "done");
  assert.doesNotMatch(s.runs[1]!.prompt, /partial repair edit/);
  assert.match(s.runs[2]!.prompt, /partial repair edit/);
});

for (const options of [{ enabled: false }, { max: 0 }, { budget: 1 }]) {
  test(`repair respects disabled/zero/exhausted budget ${JSON.stringify(options)}`, async () => {
    const s = setup(["error TS2322: wrong type"], options);
    await runStep(s.deps, s.step.id);
    assert.ok(s.repo.listAttempts(s.step.id).every(a => a.kind === "task"));
    assert.ok(!s.exec.calls.some(c => c.args[0] === "diff"));
  });
}

for (const mode of ["staged", "pr"] as const) {
  test(`${mode} gates also trigger targeted repair`, async () => {
    const s = setup(["SyntaxError: unexpected token"], { mode });
    assert.equal((await runStep(s.deps, s.step.id)).status, mode === "staged" ? "pr_open" : "done");
    assert.equal(s.repo.listAttempts(s.step.id)[1]!.kind, "repair");
  });
}

test("an unavailable cheap repair tier falls back to the task ladder", async () => {
  const s = setup(["SyntaxError: unexpected token"]);
  for (const name of s.deps.cfg.tiers.cheap) {
    const m = s.deps.cfg.models[name]!;
    s.repo.upsertModel({ name, adapter: m.adapter, tier: "cheap", preference: 0 });
    s.repo.setAvailability(name, { available: false });
  }
  assert.equal((await runStep(s.deps, s.step.id)).status, "done");
  assert.deepEqual(s.repo.listAttempts(s.step.id).map(a => [a.kind, a.model]), [["task", "gpt-6.1-sol"], ["task", "sonnet-5-5"]]);
});

test("a failed diff read stops explicitly without starting a repair", async () => {
  const s = setup(["SyntaxError: unexpected token"]);
  const exec: Exec = async (cmd, args, opts) => cmd === "git" && args[0] === "diff" ? fail("bad base") : s.exec(cmd, args, opts);
  assert.deepEqual(await runStep({ ...s.deps, exec }, s.step.id), { status: "failed", attempts: 1, reason: "repair diff failed: bad base" });
});

test("gate failures on resume cannot reset max_attempts", async () => {
  const s = setup(["error TS2322: wrong type"], { budget: 1 });
  assert.equal((await runStep(s.deps, s.step.id)).status, "failed");
  assert.equal((await runStep(s.deps, s.step.id)).status, "failed");
  assert.equal(s.runs.length, 1);
});

for (const mode of ["local", "pr"] as const) {
  test(`${mode} merge failure does not trigger repair`, async () => {
    const s = setup([], { mode });
    s.deps.cfg.verify.auto_merge = true;
    const exec = fakeExec([
      { when: c => c.cmd === "git" && c.args[0] === "rev-parse", reply: ok("main") },
      { when: c => c.args[0] === "merge" || (c.cmd === "gh" && c.args[1] === "merge"), reply: fail("branch policy refuses merge") },
      { when: () => true, reply: c => s.exec(c.cmd, c.args, c.opts) },
    ]);
    await runStep({ ...s.deps, exec }, s.step.id);
    assert.ok(s.repo.listAttempts(s.step.id).every(a => a.kind === "task"));
    assert.ok(!s.exec.calls.some(c => c.args[0] === "diff"));
  });
}
