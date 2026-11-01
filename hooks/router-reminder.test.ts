import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "../src/exec.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "router-reminder.py");

function hook(depth?: string) {
  const home = mkdtempSync(join(tmpdir(), "router-hook-"));
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
    if (depth !== undefined) env.ROUTER_DEPTH = depth;
    return spawnSync("python3", [HOOK], { encoding: "utf8", env, input: "{}" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const d of [undefined, "", "0", "abc"]) {
  test(`injeta o lembrete com ROUTER_DEPTH=${String(d)}`, () => {
    const r = hook(d);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "UserPromptSubmit");
    assert.match(out.additionalContext, /run_plan/);
  });
}

for (const d of ["1", "2"]) {
  test(`ROUTER_DEPTH=${d} não emite nada`, () => {
    const r = hook(d);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
}

test("childEnv incrementa ROUTER_DEPTH", () => {
  assert.equal(childEnv({}).ROUTER_DEPTH, "1");
  assert.equal(childEnv({ ROUTER_DEPTH: "1" }).ROUTER_DEPTH, "2");
  assert.equal(childEnv({ ROUTER_DEPTH: "x" }).ROUTER_DEPTH, "1");
  assert.equal(childEnv({ PATH: "/a" }).PATH, "/a");
});
