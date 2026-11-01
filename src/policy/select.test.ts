import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { selectModel } from "./select.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

test("picks the first model of the tier by preference", () => {
  assert.equal(selectModel(cfg, "cheap", {}), "haiku-5-5");
});

test("disabled models are never selected, even without availability state", () => {
  const copy = structuredClone(cfg);
  copy.models[copy.tiers.cheap[0]!]!.enabled = false;
  assert.equal(selectModel(copy, "cheap", {}), copy.tiers.cheap[1]);
});

test("skips an unavailable model and takes the next one of the same tier", () => {
  assert.equal(selectModel(cfg, "cheap", { "haiku-5-5": { available: false } }), "gpt-6-luna");
});

test("a model with no recorded state counts as available", () => {
  assert.equal(selectModel(cfg, "strong", {}), "opus-5-5");
});

test("returns null when the whole tier is out, never a lower tier", () => {
  const states = Object.fromEntries(cfg.tiers.cheap.map((name) => [name, { available: false }]));
  assert.equal(selectModel(cfg, "cheap", states), null);
  const midOut = Object.fromEntries(cfg.tiers.mid.map((name) => [name, { available: false }]));
  assert.equal(selectModel(cfg, "mid", midOut), null);
});

test("phase preference assigns implementation to Codex and planning to Claude", () => {
  assert.equal(selectModel(cfg, "mid", {}, "implementing"), "gpt-6.1-sol");
  assert.equal(selectModel(cfg, "strong", {}, "planning"), "opus-5-5");
  assert.equal(selectModel(cfg, "strong", {}, "full_review"), "gpt-6-astra");
});

test("phase preference falls back within its tier when the preferred model is unavailable", () => {
  assert.equal(selectModel(cfg, "mid", { "gpt-6.1-sol": { available: false } }, "implementing"), "sonnet-5-5");
});
