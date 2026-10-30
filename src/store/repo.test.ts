import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { makeRepo } from "./repo.ts";

function setup() {
  let tick = 0;
  const repo = makeRepo(openDb(), () => new Date(Date.UTC(2026, 9, 30, 0, 0, tick++)).toISOString());
  return repo;
}

test("insertTask then getTask round-trips with timestamps and default status", () => {
  const repo = setup();
  const t = repo.insertTask({ request: "renomeia uma variável", source_channel: "grok_bot" });
  const got = repo.getTask(t.id);
  assert.equal(got?.request, "renomeia uma variável");
  assert.equal(got?.status, "queued");
  assert.equal(got?.created_at, got?.updated_at);
});

test("updateTask changes fields and bumps updated_at only", () => {
  const repo = setup();
  const t = repo.insertTask({ request: "x" });
  repo.updateTask(t.id, { status: "running", tier: "mid" });
  const got = repo.getTask(t.id)!;
  assert.equal(got.status, "running");
  assert.equal(got.tier, "mid");
  assert.equal(got.created_at, t.created_at);
  assert.notEqual(got.updated_at, t.updated_at);
});

test("getTask returns undefined for an unknown id", () => {
  assert.equal(setup().getTask("nope"), undefined);
});

test("steps keep depends_on and files as arrays and list in seq order", () => {
  const repo = setup();
  const t = repo.insertTask({ request: "x" });
  repo.insertStep({ task_id: t.id, seq: 2, brief: "b", tier: "mid", depends_on: ["a"], files: ["src/a.ts"] });
  repo.insertStep({ task_id: t.id, seq: 1, brief: "a", tier: "cheap", depends_on: [], files: [] });
  const steps = repo.listSteps(t.id);
  assert.deepEqual(steps.map((s) => s.seq), [1, 2]);
  assert.deepEqual(steps[1]?.depends_on, ["a"]);
  assert.deepEqual(steps[1]?.files, ["src/a.ts"]);
  assert.equal(steps[0]?.status, "pending");
});

test("attempts store tokens and cost, and finishAttempt records the outcome", () => {
  const repo = setup();
  const t = repo.insertTask({ request: "x" });
  const s = repo.insertStep({ task_id: t.id, seq: 1, brief: "b", tier: "mid", depends_on: [], files: [] });
  const a = repo.insertAttempt({ step_id: s.id, n: 1, adapter: "claude-code", model: "sonnet-5-5", tier: "mid", effort: "medium", runner: "self_hosted" });
  repo.finishAttempt(a.id, {
    ci_result: "failed", failure_reason: "tests", input_tokens: 10, output_tokens: 20,
    cache_read_tokens: 30, cache_write_tokens: 40, est_cost_usd: 0.5,
  });
  const [got] = repo.listAttempts(s.id);
  assert.equal(got?.ci_result, "failed");
  assert.equal(got?.output_tokens, 20);
  assert.equal(got?.est_cost_usd, 0.5);
  assert.ok(got?.finished_at);
});

test("usageByTier sums tokens and cost per tier across attempts", () => {
  const repo = setup();
  const t = repo.insertTask({ request: "x" });
  const s = repo.insertStep({ task_id: t.id, seq: 1, brief: "b", tier: "cheap", depends_on: [], files: [] });
  const mk = (n: number, tier: "cheap" | "mid", cost: number) => {
    const a = repo.insertAttempt({ step_id: s.id, n, adapter: "claude-code", model: "m", tier, effort: "low", runner: "hosted" });
    repo.finishAttempt(a.id, { ci_result: "passed", input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, est_cost_usd: cost });
  };
  mk(1, "cheap", 0.1);
  mk(2, "mid", 0.4);
  mk(3, "mid", 0.2);
  const usage = repo.usageByTier();
  assert.equal(usage.mid?.attempts, 2);
  assert.equal(usage.mid?.output_tokens, 4);
  assert.ok(Math.abs((usage.mid?.est_cost_usd ?? 0) - 0.6) < 1e-9);
  assert.equal(usage.cheap?.est_cost_usd, 0.1);
});

test("models: upsert keeps one row per name, setAvailability updates it", () => {
  const repo = setup();
  repo.upsertModel({ name: "haiku-5-5", adapter: "claude-code", tier: "cheap", preference: 0 });
  repo.upsertModel({ name: "haiku-5-5", adapter: "claude-code", tier: "cheap", preference: 1 });
  repo.setAvailability("haiku-5-5", { available: false, quota_state: "exhausted" });
  const rows = repo.listModels();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.preference, 1);
  assert.equal(rows[0]?.available, false);
  assert.equal(rows[0]?.quota_state, "exhausted");
  assert.ok(rows[0]?.checked_at);
});

test("messages: undelivered ones are listed until marked delivered", () => {
  const repo = setup();
  const m = repo.insertMessage({ direction: "out", channel: "grok_bot", body: "feito" });
  assert.equal(m.delivered, false);
  assert.equal(repo.listUndelivered().length, 1);
  repo.markDelivered(m.id);
  assert.equal(repo.listUndelivered().length, 0);
});

test("setMessageChannel changes the channel of an existing message", () => {
  const repo = setup();
  const m = repo.insertMessage({ direction: "out", channel: "grok_bot", body: "x" });
  repo.setMessageChannel(m.id, "claude");
  assert.equal(repo.listUndelivered()[0]?.channel, "claude");
});
