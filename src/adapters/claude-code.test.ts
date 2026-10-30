import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { makeClaudeCode } from "./claude-code.ts";

const fixture = readFileSync(new URL("../../test/fixtures/claude-print.json", import.meta.url), "utf8");
const input = { model: "claude-sonnet-5-5", effort: "medium" as const, prompt: "faça x", cwd: "/work" };

test("builds the claude command with model, effort, json output and no session persistence", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(fixture) }]);
  await makeClaudeCode(exec).run(input);
  const call = exec.calls[0]!;
  assert.equal(call.cmd, "claude");
  assert.deepEqual(call.args.slice(0, 2), ["-p", "faça x"]);
  const expected: Array<[string, string]> = [
    ["--model", "claude-sonnet-5-5"], ["--effort", "medium"], ["--output-format", "json"], ["--permission-mode", "acceptEdits"],
  ];
  for (const [flag, value] of expected) assert.equal(call.args[call.args.indexOf(flag) + 1], value, flag);
  assert.ok(call.args.includes("--no-session-persistence"));
  assert.equal(call.opts?.cwd, "/work");
});

test("runs with minimal context: project settings only, no MCP servers, no skills, short system prompt", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(fixture) }]);
  await makeClaudeCode(exec).run(input);
  const args = exec.calls[0]!.args;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value("--setting-sources"), "project");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(value("--system-prompt")!.length < 300);
  assert.equal(value("--tools"), "Read,Write,Edit,Glob,Grep,Bash");
});

test("parses text, tokens and real cost from a real claude fixture", async () => {
  const r = await makeClaudeCode(fakeExec([{ when: () => true, reply: ok(fixture) }])).run(input);
  assert.equal(r.ok, true);
  assert.equal(r.text, "ok");
  assert.deepEqual(r.usage, { input_tokens: 2, output_tokens: 4, cache_read_tokens: 21176, cache_write_tokens: 84447 });
  assert.equal(r.cost_usd, 0.0856425);
});

test("an is_error result is not ok and carries the message", async () => {
  const body = JSON.stringify({ result: "Not logged in · Please run /login", is_error: true, total_cost_usd: 0, usage: {} });
  const r = await makeClaudeCode(fakeExec([{ when: () => true, reply: { code: 1, stdout: body, stderr: "" } }])).run(input);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Not logged in/);
  assert.equal(r.quota_exhausted, false);
});

test("a usage-limit error is flagged as quota exhausted", async () => {
  const body = JSON.stringify({ result: "Claude AI usage limit reached", is_error: true, usage: {} });
  const r = await makeClaudeCode(fakeExec([{ when: () => true, reply: { code: 1, stdout: body, stderr: "" } }])).run(input);
  assert.equal(r.quota_exhausted, true);
});

test("non-JSON output falls back to stderr", async () => {
  const r = await makeClaudeCode(fakeExec([{ when: () => true, reply: fail("boom") }])).run(input);
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
});

test("a killed process (timeout) is not ok", async () => {
  const r = await makeClaudeCode(fakeExec([{ when: () => true, reply: fail("", 124) }])).run(input);
  assert.equal(r.ok, false);
});

test("ping is available on success and reports exhausted quota otherwise", async () => {
  assert.deepEqual(await makeClaudeCode(fakeExec([{ when: () => true, reply: ok(fixture) }])).ping("claude-haiku-5-5"), { available: true, quota_state: "ok" });
  const body = JSON.stringify({ result: "usage limit reached", is_error: true, usage: {} });
  const out = await makeClaudeCode(fakeExec([{ when: () => true, reply: { code: 1, stdout: body, stderr: "" } }])).ping("claude-haiku-5-5");
  assert.deepEqual(out, { available: false, quota_state: "exhausted" });
});
