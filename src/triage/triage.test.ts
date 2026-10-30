import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { ZERO_USAGE, type Adapter, type RunResult } from "../adapters/types.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { triage } from "./triage.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

const reply = (text: string, ok = true): RunResult => ({ ok, text, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false });
function fakeAdapter(...texts: string[]) {
  const prompts: string[] = [];
  const models: string[] = [];
  const adapter: Adapter = {
    async run(i) {
      prompts.push(i.prompt);
      models.push(i.model);
      return reply(texts[Math.min(prompts.length - 1, texts.length - 1)]!);
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  return { adapter, prompts, models };
}
const adapters = (a: Adapter) => ({ "claude-code": a, "grok-build": a });
const cwd = "/work";
const repo = makeRepo(openDb());

test("classifies a trivial edit as cheap/low using the triage model", async () => {
  const f = fakeAdapter('{"phase":"simple_edit","tier":"cheap"}');
  const r = await triage(cfg, adapters(f.adapter), "renomeia uma variável", { cwd, repo });
  assert.deepEqual(r, { phase: "simple_edit", tier: "cheap", effort: "low" });
  assert.equal(f.models[0], "claude-haiku-5-5");
  assert.match(f.prompts[0]!, /renomeia uma variável/);
});

test("accepts JSON wrapped in prose or a code fence", async () => {
  const f = fakeAdapter('Claro:\n```json\n{"phase":"planning","tier":"strong"}\n```');
  const r = await triage(cfg, adapters(f.adapter), "refatora a fila para suportar prioridade", { cwd, repo });
  assert.deepEqual(r, { phase: "planning", tier: "strong", effort: "high" });
});

test("override_tier wins without calling any model", async () => {
  const f = fakeAdapter("nunca usado");
  const r = await triage(cfg, adapters(f.adapter), "qualquer coisa", { cwd, repo, overrideTier: "mid" });
  assert.deepEqual(r, { phase: "implementing", tier: "mid", effort: "medium" });
  assert.equal(f.prompts.length, 0);
});

test("invalid JSON is retried once, then succeeds", async () => {
  const f = fakeAdapter("não sei", '{"phase":"implementing","tier":"mid"}');
  const r = await triage(cfg, adapters(f.adapter), "x", { cwd, repo });
  assert.equal(r.tier, "mid");
  assert.equal(f.prompts.length, 2);
});

test("a tier that contradicts the phase is invalid", async () => {
  const f = fakeAdapter('{"phase":"simple_edit","tier":"strong"}');
  await assert.rejects(() => triage(cfg, adapters(f.adapter), "x", { cwd, repo }), /triage/);
  assert.equal(f.prompts.length, 2);
});

test("two invalid answers give a clear error", async () => {
  const f = fakeAdapter("lixo");
  await assert.rejects(() => triage(cfg, adapters(f.adapter), "x", { cwd, repo }), /triage: invalid answer after 2 tries/);
});

test("a failing adapter call is an error, not a silent default", async () => {
  const adapter: Adapter = {
    async run() {
      return { ...reply("", false), error: "boom" };
    },
    async ping() {
      return { available: false, quota_state: "error" };
    },
  };
  await assert.rejects(() => triage(cfg, adapters(adapter), "x", { cwd, repo }), /boom/);
});

test("quota exhaustion on the triage model falls back to the next cheap model", async () => {
  const repo = makeRepo(openDb());
  const models: string[] = [];
  const adapter: Adapter = {
    async run(i) {
      models.push(i.model);
      if (i.model === "claude-haiku-5-5") return { ...reply("", false), quota_exhausted: true };
      return reply('{"phase":"simple_edit","tier":"cheap"}');
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const r = await triage(cfg, adapters(adapter), "x", { cwd, repo });
  assert.equal(r.tier, "cheap");
  assert.deepEqual(models, ["claude-haiku-5-5", "grok-4.7-build-fast"]);
  assert.equal(repo.listModels().find((m) => m.name === "haiku-5-5")?.available, false);
});

test("an unavailable triage model is skipped for the next cheap one; none available is a clear error", async () => {
  const repo = makeRepo(openDb());
  const f = fakeAdapter('{"phase":"simple_edit","tier":"cheap"}');
  repo.upsertModel({ name: "haiku-5-5", adapter: "claude-code", tier: "cheap", preference: 0 });
  repo.setAvailability("haiku-5-5", { available: false, quota_state: "exhausted" });
  await triage(cfg, adapters(f.adapter), "x", { cwd, repo });
  assert.deepEqual(f.models, ["grok-4.7-build-fast"]);
  repo.upsertModel({ name: "grok-fast", adapter: "grok-build", tier: "cheap", preference: 1 });
  repo.setAvailability("grok-fast", { available: false, quota_state: "exhausted" });
  await assert.rejects(() => triage(cfg, adapters(f.adapter), "x", { cwd, repo }), /triage: no cheap model available/);
});
