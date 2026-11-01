import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { ROLES, selectForRole } from "./selection.ts";

const config = () => loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);

test("every executable responsibility has an explicit valid agent, model and effort", () => {
  const cfg = config();
  for (const role of ROLES) {
    const choice = selectForRole(cfg, role);
    assert.ok(choice, role);
    assert.ok(["claude-code", "codex"].includes(choice.adapter));
    assert.equal(cfg.models[choice.model]?.id, choice.model_id);
    assert.equal(cfg.models[choice.model]?.tier, choice.tier);
    assert.ok(["low", "medium", "high", "xhigh"].includes(choice.effort));
  }
  assert.equal(selectForRole(cfg, "triage")?.effort, "low");
  assert.equal(selectForRole(cfg, "implementing")?.model, "gpt-6.1-sol");
  assert.equal(selectForRole(cfg, "investigation")?.effort, "high");
  assert.equal(selectForRole(cfg, "review")?.tier, "mid");
  assert.notEqual(selectForRole(cfg, "specialized")?.model, "gpt-6.1-terra");
});

test("cost wins over preference within the capable category; ties preserve preference", () => {
  const cfg = config();
  assert.equal(selectForRole(cfg, "integration")?.model, "opus-5-5");
  cfg.models["sonnet-5-5"]!.price.input = 1;
  assert.equal(selectForRole(cfg, "implementing")?.model, "sonnet-5-5");
  assert.equal(selectForRole(cfg, "planning")?.tier, "strong");
});

test("disabled, unavailable and Grok models never win, even when cheapest and preferred", () => {
  const cfg = config();
  cfg.models.grok = { ...cfg.models["haiku-5-5"]!, adapter: "grok-build", id: "grok", price: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
  cfg.tiers.cheap.unshift("grok");
  cfg.phases.simple_edit.prefer.unshift("grok");
  cfg.triage.model = "grok";
  assert.equal(selectForRole(cfg, "triage")?.model, "haiku-5-5");
  cfg.models["haiku-5-5"]!.enabled = false;
  assert.equal(selectForRole(cfg, "simple_edit")?.model, "gpt-6-luna");
  assert.equal(selectForRole(cfg, "simple_edit", { "gpt-6-luna": { available: false } }), null);
  for (const tier of ["mid", "strong"] as const) {
    cfg.models[`grok-${tier}`] = { ...cfg.models.grok, tier };
    cfg.tiers[tier].unshift(`grok-${tier}`);
  }
  for (const role of ROLES) assert.notEqual(selectForRole(cfg, role)?.adapter, "grok-build");
});

test("bounded review crosses the author when supplied without selecting a disabled specialist", () => {
  const cfg = config();
  assert.equal(selectForRole(cfg, "review", {}, { author: "codex" })?.adapter, "claude-code");
  assert.equal(selectForRole(cfg, "review", {}, { author: "claude-code" })?.adapter, "codex");
  assert.equal(selectForRole(cfg, "review", { "sonnet-5-5": { available: false } }, { author: "codex" }), null);
});
