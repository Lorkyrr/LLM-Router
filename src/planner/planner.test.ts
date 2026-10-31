import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { ZERO_USAGE, type Adapter, type RunInput } from "../adapters/types.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { plan } from "./planner.ts";

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
const steps = (...s: object[]) => JSON.stringify({ steps: s });

test("plans with the strong model and stores steps with ids as dependencies", async () => {
  const s = setup(
    steps(
      { tier: "mid", brief: "a", depends_on: [], files: ["src/a.ts"] },
      { tier: "mid", brief: "b", depends_on: [1], files: ["src/b.ts"] },
    ),
  );
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.equal(s.calls[0]!.model, "claude-opus-5-5");
  assert.equal(s.calls[0]!.effort, "high");
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

test("no strong model available marks the task waiting_quota", async () => {
  const s = setup("x");
  for (const name of cfg.tiers.strong) {
    s.repo.upsertModel({ name, adapter: "claude-code", tier: "strong", preference: 0 });
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
      if (i.model === "claude-opus-5-5") return { ok: false, text: "", usage: ZERO_USAGE, cost_usd: null, quota_exhausted: true, error: "quota" };
      return { ok: true, text: okText, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const task = repo.insertTask({ request: "r" });
  return { repo, models, task, adapters: { "claude-code": adapter, "grok-build": adapter, codex: adapter } };
}

test("quota exhaustion falls back to the next strong model and marks the first unavailable", async () => {
  const s = quotaThenOk(steps({ tier: "mid", brief: "a", depends_on: [], files: [] }));
  const out = await plan(cfg, s.adapters, s.repo, s.task.id, { cwd: "/w" });
  assert.deepEqual(s.models, ["claude-opus-5-5", "gpt-6-astra"]);
  assert.equal(out.length, 1);
  assert.equal(s.repo.listModels().find((m) => m.name === "opus-5-5")?.available, false);
});

test("quota exhausted on every strong model leaves the task waiting_quota", async () => {
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
