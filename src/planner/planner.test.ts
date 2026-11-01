import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { ZERO_USAGE, type Adapter, type RunInput } from "../adapters/types.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { plan } from "./planner.ts";
import { ROLES } from "./selection.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

function setup(...texts: string[]) {
  const repo = makeRepo(openDb());
  const calls: RunInput[] = [];
  const adapter: Adapter = {
    async run(i) {
      calls.push(i);
      const text = texts[Math.min(calls.length - 1, texts.length - 1)]!;
      return { ok: true, text, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const task = repo.insertTask({ request: "feature em 3 partes" });
  return { repo, calls, task, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter } };
}
// risk é obrigatório no contrato do planner; os testes que não tratam dele declaram "low".
const steps = (...s: object[]) => JSON.stringify({ steps: s.map((x) => ({ risk: "low", ...x })) });

test("decomposes with cheap low and stores steps with ids as dependencies", async () => {
  const s = setup(
    steps(
      { tier: "mid", brief: "a", depends_on: [], files: ["src/a.ts"] },
      { tier: "mid", brief: "b", depends_on: [1], files: ["src/b.ts"] },
    ),
  );
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.equal(s.calls[0]!.model, "claude-haiku-5-5");
  assert.equal(s.calls[0]!.effort, "low");
  assert.deepEqual(out.map((x) => x.seq), [1, 2]);
  assert.deepEqual(out[1]!.depends_on, [out[0]!.id]);
  assert.equal(s.repo.listSteps(s.task.id).length, 2);
  assert.equal(s.repo.getTask(s.task.id)!.status, "planning");
});

test("steps that share a file become sequential even if the model said independent", async () => {
  const s = setup(
    steps(
      { tier: "mid", brief: "a", depends_on: [], files: ["src/q.ts", "src/a.ts"] },
      { tier: "mid", brief: "b", depends_on: [], files: ["src/q.ts"] },
      { tier: "mid", brief: "c", depends_on: [], files: ["src/z.ts"] },
    ),
  );
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(out[1]!.depends_on, [out[0]!.id]);
  assert.deepEqual(out[2]!.depends_on, []);
});

test("the prompt carries the request but no history", async () => {
  const s = setup(steps({ tier: "mid", brief: "a", depends_on: [], files: [] }));
  await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.match(s.calls[0]!.prompt, /feature em 3 partes/);
});

test("a forward or self dependency is rejected", async () => {
  const s = setup(steps({ tier: "mid", brief: "a", depends_on: [1], files: [] }));
  await assert.rejects(() => plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" }), /planner: invalid plan/);
  assert.equal(s.repo.listSteps(s.task.id).length, 0);
});

test("invalid JSON is retried once", async () => {
  const s = setup("hmm", steps({ tier: "mid", brief: "a", depends_on: [], files: [] }));
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.equal(out.length, 1);
  assert.equal(s.calls.length, 2);
});

test("no cheap model available marks the task waiting_quota", async () => {
  const s = setup("x");
  for (const name of cfg.tiers.cheap) {
    s.repo.upsertModel({ name, adapter: "claude-code", tier: "cheap", preference: 0 });
    s.repo.setAvailability(name, { available: false, quota_state: "exhausted" });
  }
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(out, []);
  assert.equal(s.repo.getTask(s.task.id)!.status, "waiting_quota");
  assert.equal(s.calls.length, 0);
});

function quotaThenOk(okText: string) {
  const repo = makeRepo(openDb());
  const models: string[] = [];
  const adapter: Adapter = {
    async run(i) {
      models.push(i.model);
      if (i.model === "claude-haiku-5-5") return { ok: false, text: "", usage: ZERO_USAGE, cost_usd: null, quota_exhausted: true, error: "quota" };
      return { ok: true, text: okText, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const task = repo.insertTask({ request: "r" });
  return { repo, models, task, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter } };
}

test("quota exhaustion falls back within cheap and marks the first unavailable", async () => {
  const s = quotaThenOk(steps({ tier: "mid", brief: "a", depends_on: [], files: [] }));
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(s.models, ["claude-haiku-5-5", "gpt-6-luna"]);
  assert.equal(out.length, 1);
  assert.equal(s.repo.listModels().find((m) => m.name === "haiku-5-5")?.available, false);
});

test("quota exhausted on every cheap model leaves the task waiting_quota", async () => {
  const s = quotaThenOk("x");
  const exhausted: Adapter = { run: async () => ({ ok: false, text: "", usage: ZERO_USAGE, cost_usd: null, quota_exhausted: true }), ping: async () => ({ available: false, quota_state: "exhausted" }) };
  const out = await plan(cfg, { "claude-code": exhausted, "grok-build": exhausted, codex: exhausted }, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(out, []);
  assert.equal(s.repo.getTask(s.task.id)!.status, "waiting_quota");
});

test("planning a task that already has steps is refused", async () => {
  const s = setup(steps({ tier: "mid", brief: "a", depends_on: [], files: [] }));
  await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  await assert.rejects(() => plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" }), /already has steps/);
  assert.equal(s.repo.listSteps(s.task.id).length, 1);
});

test("each subtask role survives storage and receives its own model and effort", async () => {
  const s = setup(steps(...ROLES.map((role) => ({ role, brief: role, depends_on: [], files: [] }))));
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(s.repo.listSteps(s.task.id).map((step) => step.role), [...ROLES]);
  assert.deepEqual(out.map((step) => step.selection?.role), [...ROLES]);
  assert.deepEqual(out.map((step) => [step.selection?.model, step.selection?.effort]), [
    ["haiku-5-5", "low"], ["haiku-5-5", "low"], ["opus-5-5", "high"],
    ["gpt-6.1-sol", "medium"], ["opus-5-5", "high"], ["opus-5-5", "high"],
    ["gpt-6.1-sol", "medium"], ["opus-5-5", "high"], ["gpt-6.1-sol", "medium"],
  ]);
});

test("unavailable subtask category waits without dropping to a cheaper incapable category", async () => {
  const s = setup(steps({ role: "planning", brief: "contrato", depends_on: [], files: [] }));
  for (const name of cfg.tiers.strong) {
    s.repo.upsertModel({ name, adapter: cfg.models[name]!.adapter, tier: "strong", preference: 0 });
    s.repo.setAvailability(name, { available: false });
  }
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.equal(out[0]?.selection, null);
  assert.equal(s.repo.getTask(s.task.id)?.status, "waiting_quota");
});

test("acceptance, risk and risk_reasons declared by the planner are stored on the steps", async () => {
  const s = setup(steps(
    { tier: "mid", brief: "a", depends_on: [], files: [], acceptance: ["npm test passa"], risk: "high", risk_reasons: ["migração"] },
    { tier: "mid", brief: "b", depends_on: [], files: ["z.ts"], risk: "high" },
    { tier: "mid", brief: "c", depends_on: [], files: ["y.ts"] },
  ));
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  const stored = s.repo.listSteps(s.task.id);
  assert.deepEqual(stored.map((x) => [x.acceptance, x.risk, x.risk_reasons]), [
    [["npm test passa"], "high", ["migração"]],
    [["b"], "high", ["planner"]],
    [["c"], "low", []],
  ]);
  assert.deepEqual(out.map((x) => [x.acceptance, x.risk, x.risk_reasons]), stored.map((x) => [x.acceptance, x.risk, x.risk_reasons]));
});

test("a plan whose steps omit risk is rejected and nothing is stored", async () => {
  const s = setup(JSON.stringify({ steps: [{ tier: "mid", brief: "a", depends_on: [], files: [] }] }));
  await assert.rejects(() => plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" }), /planner: invalid plan/);
  assert.equal(s.repo.listSteps(s.task.id).length, 0);
});
