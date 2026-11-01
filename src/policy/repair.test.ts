import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { repairFor } from "./repair.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
const original = { tier: "strong" as const, effort: "high" as const };
const small = "--- a/a.ts\n+++ b/a.ts\n-old\n+new";

test("simple diagnostics respect configurable diff and test thresholds", () => {
  for (const diagnostic of ["error TS2304: missing x", "SyntaxError", "Cannot find module 'x'", "lint error", "not ok 1 - a.test.ts\n# fail 1", "Tests: 2 failed, 20 passed", "Tests  2 failed | 20 passed"]) {
    assert.equal(repairFor(cfg, original, diagnostic, small, 0).tier, "cheap", diagnostic);
  }
  for (const diagnostic of ["# fail 3\nerror TS2322", "Tests: 3 failed", "Tests  3 failed | 20 passed", "3 failing", "unknown assertion"]) {
    assert.equal(repairFor(cfg, original, diagnostic, small, 0).tier, "strong", diagnostic);
  }
  assert.equal(repairFor(cfg, original, "error TS2322", "+new\n".repeat(101), 0).tier, "strong");
  assert.equal(repairFor(cfg, original, "error TS2322", "+new\n".repeat(100), 0).tier, "cheap");
  const custom = { ...cfg, repair: { ...cfg.repair, simple: { max_failed_tests: 0, max_diff_lines: 1, patterns: ["custom error"] } } };
  assert.equal(repairFor(custom, original, "custom error", "+new", 0).tier, "cheap");
  assert.equal(repairFor(custom, original, "custom error", small, 0).tier, "strong");
  assert.equal(repairFor(custom, original, "not ok 1\ncustom error", "+new", 0).tier, "strong");
});

test("diff content starting with plus/minus operators counts toward the threshold", () => {
  const limited = { ...cfg, repair: { ...cfg.repair, simple: { ...cfg.repair.simple, max_diff_lines: 1 } } };
  assert.equal(repairFor(limited, original, "SyntaxError", "+++counter;\n---counter;", 0).tier, "strong");
});

test("passing Jest/Vitest summaries do not count as failed tests", () => {
  for (const summary of ["Tests: 20 passed", "Tests  20 passed | 20 total"]) {
    assert.equal(repairFor(cfg, original, `${summary}\nCannot find module x`, small, 0).tier, "cheap");
  }
});
