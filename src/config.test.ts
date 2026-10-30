import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "./config.ts";

const base = () => ({
  triage: { model: "haiku", effort: "low" },
  models: {
    haiku: { adapter: "claude-code", id: "claude-haiku-5-5", tier: "cheap", price: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
    sonnet: { adapter: "claude-code", id: "claude-sonnet-5-5", tier: "mid", price: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    opus: { adapter: "claude-code", id: "claude-opus-5-5", tier: "strong", price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
  },
  tiers: { cheap: ["haiku"], mid: ["sonnet"], strong: ["opus"] },
  phases: {
    planning: { tier: "strong", effort: "high" },
    implementing: { tier: "mid", effort: "medium" },
    integration: { tier: "strong", effort: "medium" },
    full_review: { tier: "strong", effort: "high" },
    simple_edit: { tier: "cheap", effort: "low" },
  },
  escalation: {
    max_attempts: 3,
    ladder: {
      cheap: [{ tier: "cheap", effort: "low" }, { tier: "mid", effort: "medium" }, { tier: "mid", effort: "high" }],
      mid: [{ tier: "mid", effort: "medium" }, { tier: "mid", effort: "high" }, { tier: "mid", effort: "xhigh" }],
      strong: [{ tier: "strong", effort: "high" }, { tier: "strong", effort: "xhigh" }],
    },
  },
  verify: { auto_merge: true, delete_branch: true },
  dispatch: { cloud_tiers: ["cheap", "mid"], heartbeat_timeout_s: 600 },
});

test("a valid config parses", () => {
  assert.equal(parseConfig(base()).models.haiku?.tier, "cheap");
});

test("config/router.yaml in the repo is valid", () => {
  const cfg = loadConfig(new URL("../config/router.yaml", import.meta.url).pathname);
  assert.ok(cfg.tiers.strong.length > 0);
});

test("rejects a model listed in two tiers", () => {
  const c = base();
  c.tiers.mid = ["sonnet", "opus"];
  assert.throws(() => parseConfig(c), /opus/);
});

test("rejects a tier list that references an unknown model", () => {
  const c = base();
  c.tiers.cheap = ["ghost"];
  assert.throws(() => parseConfig(c), /ghost/);
});

test("rejects a model whose tier differs from the list it is in", () => {
  const c = base();
  c.models.sonnet.tier = "strong";
  assert.throws(() => parseConfig(c), /sonnet/);
});

test("rejects an empty tier", () => {
  const c = base();
  c.tiers.mid = [];
  assert.throws(() => parseConfig(c));
});

test("rejects a ladder that steps down a tier", () => {
  const c = base();
  c.escalation.ladder.mid = [{ tier: "mid", effort: "medium" }, { tier: "cheap", effort: "low" }];
  assert.throws(() => parseConfig(c), /ladder/);
});
