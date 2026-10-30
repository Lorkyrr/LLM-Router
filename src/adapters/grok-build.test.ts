import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { makeGrokBuild } from "./grok-build.ts";

const fixture = readFileSync(new URL("../../test/fixtures/grok-print.json", import.meta.url), "utf8");
const input = { model: "grok-4.7-build-fast", effort: "high" as const, prompt: "faça y", cwd: "/work" };

test("builds the grok command with model, reasoning effort and json output", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(fixture) }]);
  await makeGrokBuild(exec).run(input);
  const call = exec.calls[0]!;
  assert.equal(call.cmd, "grok");
  assert.deepEqual(call.args.slice(0, 2), ["-p", "faça y"]);
  const expected: Array<[string, string]> = [
    ["-m", "grok-4.7-build-fast"], ["--reasoning-effort", "high"], ["--output-format", "json"], ["--permission-mode", "acceptEdits"],
  ];
  for (const [flag, value] of expected) assert.equal(call.args[call.args.indexOf(flag) + 1], value, flag);
  assert.equal(call.opts?.cwd, "/work");
});

test("parses text, tokens and real cost from a real grok fixture", async () => {
  const r = await makeGrokBuild(fakeExec([{ when: () => true, reply: ok(fixture) }])).run(input);
  assert.equal(r.ok, true);
  assert.equal(r.text, "ok");
  assert.deepEqual(r.usage, { input_tokens: 20071, output_tokens: 150, cache_read_tokens: 7040, cache_write_tokens: 0 });
  assert.equal(r.cost_usd, 0.01515108);
});

test("a non-zero exit is not ok and a rate-limit message is flagged as quota", async () => {
  const r = await makeGrokBuild(fakeExec([{ when: () => true, reply: fail("rate limit exceeded") }])).run(input);
  assert.equal(r.ok, false);
  assert.equal(r.quota_exhausted, true);
});

test("ping reports available on success", async () => {
  assert.deepEqual(await makeGrokBuild(fakeExec([{ when: () => true, reply: ok(fixture) }])).ping("grok-4.7"), { available: true, quota_state: "ok" });
});
