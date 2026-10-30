import { test } from "node:test";
import assert from "node:assert/strict";
import { failedTests, regressions } from "./compare-baseline.ts";

const tap = (...lines: string[]) => lines.join("\n");

test("collects only failing test names from TAP output", () => {
  const out = tap("ok 1 - a", "not ok 2 - b", "  not ok 3 - nested c", "ok 4 - d # SKIP");
  assert.deepEqual([...failedTests(out)].sort(), ["b", "nested c"]);
});

test("a test that already failed on the stable base is not a regression", () => {
  const base = tap("ok 1 - a", "not ok 2 - flaky");
  const pr = tap("ok 1 - a", "not ok 2 - flaky");
  assert.deepEqual(regressions(base, pr), []);
});

test("a test that passed on base and fails on the PR is a regression", () => {
  const base = tap("ok 1 - a", "ok 2 - b");
  const pr = tap("ok 1 - a", "not ok 2 - b");
  assert.deepEqual(regressions(base, pr), ["b"]);
});

test("a PR run with no test results at all counts as a regression", () => {
  assert.deepEqual(regressions(tap("ok 1 - a"), "crash"), ["<no test results from the PR run>"]);
});
