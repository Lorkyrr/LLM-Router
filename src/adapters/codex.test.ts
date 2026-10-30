import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCodex } from "./codex.ts";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";

const input = { model: "gpt-6.1-sol", effort: "medium" as const, prompt: "implemente o brief", cwd: "/work" };
const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const completed = (input_tokens = 1000, cached_input_tokens = 800, output_tokens = 200) =>
  ({ type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } });
const message = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });

test("Codex uses an ephemeral sandboxed session with explicit model and effort", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(stream(message("feito"), completed())) }]);
  const result = await makeCodex(exec).run(input);
  const call = exec.calls[0]!;
  assert.equal(call.cmd, "codex");
  assert.equal(call.args[0], "exec");
  for (const flag of ["--json", "--ephemeral", "--ignore-user-config"]) assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf("--model") + 1], input.model);
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(call.args.includes('model_reasoning_effort="medium"'));
  assert.ok(!call.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(call.args.at(-1), input.prompt);
  assert.equal(call.opts?.cwd, input.cwd);
  assert.equal(result.ok, true);
  assert.equal(result.text, "feito");
  assert.deepEqual(result.usage, { input_tokens: 200, cache_read_tokens: 800, cache_write_tokens: 0, output_tokens: 200 });
  assert.equal(result.cost_usd, null);
});

test("Codex aggregates completed turns and returns the last agent message", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(stream(message("parcial"), completed(), message("final"), completed(200, 0, 20))) }]);
  const r = await makeCodex(exec).run(input);
  assert.equal(r.text, "final");
  assert.equal(r.usage.input_tokens, 400);
  assert.equal(r.usage.output_tokens, 220);
});

test("Codex rejects truncated, malformed and empty output", async () => {
  for (const stdout of ["", stream(message("parece pronto")), "invalid json\n", stream(completed(-1))]) {
    const r = await makeCodex(fakeExec([{ when: () => true, reply: ok(stdout) }])).run(input);
    assert.equal(r.ok, false, stdout);
  }
});

test("Codex reports quota failures even without an agent message", async () => {
  const stdout = stream({ type: "turn.failed", error: { message: "Usage limit reached" } });
  const r = await makeCodex(fakeExec([{ when: () => true, reply: { ...fail(), stdout } }])).run(input);
  assert.equal(r.ok, false);
  assert.equal(r.quota_exhausted, true);
  assert.match(r.error!, /Usage limit/);
});

test("Codex ping is read-only and supports a non-git temporary directory", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok(stream(message("ok"), completed())) }]);
  assert.equal((await makeCodex(exec).ping(input.model)).available, true);
  const args = exec.calls[0]!.args;
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok((exec.calls[0]!.opts?.timeoutMs ?? 0) > 0);
});

test("Codex reports cache writes separately from fresh input", async () => {
  const done = { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 5 } };
  const r = await makeCodex(fakeExec([{ when: () => true, reply: ok(stream(message("x"), done)) }])).run(input);
  assert.deepEqual(r.usage, { input_tokens: 300, cache_read_tokens: 600, cache_write_tokens: 100, output_tokens: 5 });
});
