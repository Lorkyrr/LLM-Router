import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { ZERO_USAGE, type Adapter, type RunResult } from "../adapters/types.ts";
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

test("classifies a trivial edit as cheap/low using the triage model", async () => {
  const f = fakeAdapter('{"phase":"simple_edit","tier":"cheap"}');
  const r = await triage(cfg, adapters(f.adapter), "renomeia uma variável", { cwd });
  assert.deepEqual(r, { phase: "simple_edit", tier: "cheap", effort: "low" });
  assert.equal(f.models[0], "claude-haiku-5-5");
  assert.match(f.prompts[0]!, /renomeia uma variável/);
});

test("accepts JSON wrapped in prose or a code fence", async () => {
  const f = fakeAdapter('Claro:\n```json\n{"phase":"planning","tier":"strong"}\n```');
  const r = await triage(cfg, adapters(f.adapter), "refatora a fila para suportar prioridade", { cwd });
  assert.deepEqual(r, { phase: "planning", tier: "strong", effort: "high" });
});

test("override_tier wins without calling any model", async () => {
  const f = fakeAdapter("nunca usado");
  const r = await triage(cfg, adapters(f.adapter), "qualquer coisa", { cwd, overrideTier: "mid" });
  assert.deepEqual(r, { phase: "implementing", tier: "mid", effort: "medium" });
  assert.equal(f.prompts.length, 0);
});

test("invalid JSON is retried once, then succeeds", async () => {
  const f = fakeAdapter("não sei", '{"phase":"implementing","tier":"mid"}');
  const r = await triage(cfg, adapters(f.adapter), "x", { cwd });
  assert.equal(r.tier, "mid");
  assert.equal(f.prompts.length, 2);
});

test("a tier that contradicts the phase is invalid", async () => {
  const f = fakeAdapter('{"phase":"simple_edit","tier":"strong"}');
  await assert.rejects(() => triage(cfg, adapters(f.adapter), "x", { cwd }), /triage/);
  assert.equal(f.prompts.length, 2);
});

test("two invalid answers give a clear error", async () => {
  const f = fakeAdapter("lixo");
  await assert.rejects(() => triage(cfg, adapters(f.adapter), "x", { cwd }), /triage: invalid answer after 2 tries/);
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
  await assert.rejects(() => triage(cfg, adapters(adapter), "x", { cwd }), /boom/);
});
