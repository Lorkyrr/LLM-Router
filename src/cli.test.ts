import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli.ts";

test("parseArgs reads run --task", () => {
  assert.deepEqual(parseArgs(["run", "--task", "abc"]), { command: "run", task: "abc" });
});

test("parseArgs rejects missing or extra arguments", () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["run", "--task"]), /usage/);
  assert.throws(() => parseArgs(["run", "--task", "a", "b"]), /usage/);
  assert.throws(() => parseArgs(["go", "--task", "a"]), /usage/);
});
