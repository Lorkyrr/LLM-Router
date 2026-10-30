import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "../config.ts";
import { stepFor } from "./escalate.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

test("cheap climbs to mid medium, then mid high, then stops", () => {
  assert.deepEqual(stepFor(cfg, "cheap", 1), { tier: "cheap", effort: "low" });
  assert.deepEqual(stepFor(cfg, "cheap", 2), { tier: "mid", effort: "medium" });
  assert.deepEqual(stepFor(cfg, "cheap", 3), { tier: "mid", effort: "high" });
  assert.equal(stepFor(cfg, "cheap", 4), null);
});

test("mid climbs medium, high, xhigh", () => {
  assert.deepEqual(stepFor(cfg, "mid", 1), { tier: "mid", effort: "medium" });
  assert.deepEqual(stepFor(cfg, "mid", 3), { tier: "mid", effort: "xhigh" });
});

test("strong stops after xhigh even though max_attempts is 3", () => {
  assert.deepEqual(stepFor(cfg, "strong", 2), { tier: "strong", effort: "xhigh" });
  assert.equal(stepFor(cfg, "strong", 3), null);
});

test("max_attempts caps the ladder", () => {
  const capped = parseConfig({ ...cfg, escalation: { ...cfg.escalation, max_attempts: 2 } });
  assert.equal(stepFor(capped, "mid", 3), null);
});

test("attempt numbers below 1 are rejected", () => {
  assert.throws(() => stepFor(cfg, "mid", 0));
});
