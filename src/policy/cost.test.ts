import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { estimateCost, strongBaseline } from "./cost.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 };

test("estimateCost sums the four token kinds at the model price", () => {
  const haiku = cfg.models["haiku-5-5"]!.price;
  assert.equal(estimateCost(haiku, usage), 1 + 5 + 0.1 + 1.25);
});

test("strongBaseline prices the same usage at the first strong model", () => {
  const opus = cfg.models["opus-5-5"]!.price;
  assert.equal(strongBaseline(cfg, usage), estimateCost(opus, usage));
});

test("zero usage costs zero", () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  assert.equal(strongBaseline(cfg, zero), 0);
});
