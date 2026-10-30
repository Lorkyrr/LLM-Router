import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedTiers, isCorrect } from "./bench.ts";

test("effort labels map to tiers: low=cheap, medium=mid, high and xhigh=strong", () => {
  assert.deepEqual([...expectedTiers(["low"])], ["cheap"]);
  assert.deepEqual([...expectedTiers(["high", "xhigh"])], ["strong"]);
  assert.deepEqual([...expectedTiers(["medium", "high"])].sort(), ["mid", "strong"]);
});

test("a prediction is correct when its tier is among the acceptable ones", () => {
  assert.equal(isCorrect("mid", ["medium", "high"]), true);
  assert.equal(isCorrect("cheap", ["medium", "high"]), false);
});
