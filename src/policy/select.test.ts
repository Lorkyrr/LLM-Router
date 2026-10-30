import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { selectModel } from "./select.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

test("picks the first model of the tier by preference", () => {
  assert.equal(selectModel(cfg, "cheap", {}), "haiku-5-5");
});

test("skips an unavailable model and takes the next one of the same tier", () => {
  assert.equal(selectModel(cfg, "cheap", { "haiku-5-5": { available: false } }), "grok-fast");
});

test("a model with no recorded state counts as available", () => {
  assert.equal(selectModel(cfg, "strong", {}), "opus-5-5");
});

test("returns null when the whole tier is out, never a lower tier", () => {
  const states = { "haiku-5-5": { available: false }, "grok-fast": { available: false } };
  assert.equal(selectModel(cfg, "cheap", states), null);
  const midOut = { "sonnet-5-5": { available: false } };
  assert.equal(selectModel(cfg, "mid", midOut), null);
});
