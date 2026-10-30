import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import type { Adapter, Availability } from "../adapters/types.ts";
import { availability, checkModels } from "./check.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const stub = (answer: (model: string) => Availability): Adapter => ({
  run: async () => { throw new Error("not used"); },
  ping: async (model) => answer(model),
});

test("checkModels pings every configured model and stores the result with its tier and preference", async () => {
  const repo = makeRepo(openDb());
  const adapters = {
    "claude-code": stub((m) => (m === "claude-haiku-5-5" ? { available: false, quota_state: "exhausted" } : { available: true, quota_state: "ok" })),
    "grok-build": stub(() => ({ available: true, quota_state: "ok" })),
  };
  await checkModels(cfg, adapters, repo);
  const rows = Object.fromEntries(repo.listModels().map((r) => [r.name, r]));
  assert.equal(Object.keys(rows).length, Object.keys(cfg.models).length);
  assert.equal(rows["haiku-5-5"]?.available, false);
  assert.equal(rows["haiku-5-5"]?.quota_state, "exhausted");
  assert.equal(rows["grok-fast"]?.preference, 1);
  assert.equal(rows["opus-5-5"]?.tier, "strong");
});

test("availability maps stored rows to the shape selectModel expects", async () => {
  const repo = makeRepo(openDb());
  repo.upsertModel({ name: "haiku-5-5", adapter: "claude-code", tier: "cheap", preference: 0 });
  repo.setAvailability("haiku-5-5", { available: false, quota_state: "exhausted" });
  assert.deepEqual(availability(repo), { "haiku-5-5": { available: false } });
});

test("a ping that throws marks the model unavailable instead of failing the whole check", async () => {
  const repo = makeRepo(openDb());
  const boom: Adapter = { run: async () => { throw new Error("x"); }, ping: async () => { throw new Error("spawn failed"); } };
  await checkModels(cfg, { "claude-code": boom, "grok-build": boom }, repo);
  assert.ok(repo.listModels().every((m) => m.available === false && m.quota_state === "error"));
});
