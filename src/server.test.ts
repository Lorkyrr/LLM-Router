import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { ZERO_USAGE, type Adapter } from "./adapters/types.ts";
import { fakeExec } from "../test/fixtures/fake-exec.ts";
import { openDb } from "./store/db.ts";
import { makeRepo } from "./store/repo.ts";
import { makeServer } from "./server.ts";

const cfg = loadConfig(new URL("../config/router.yaml", import.meta.url).pathname);

async function connect(answers: string[], transport = async () => {}) {
  const repo = makeRepo(openDb());
  let i = 0;
  const adapter: Adapter = {
    async run() {
      return { ok: true, text: answers[Math.min(i++, answers.length - 1)]!, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false };
    },
    async ping() {
      return { available: true, quota_state: "ok" };
    },
  };
  const server = makeServer({
    cfg, adapters: { "claude-code": adapter, "grok-build": adapter }, repo, exec: fakeExec([]),
    repoDir: "/r", base: "main", runner: "hosted", transport,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { error: r.isError === true, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
  };
  return { call, repo };
}

test("lists the six tools", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const repo = makeRepo(openDb());
  const dummy = {} as never;
  await makeServer({ cfg, adapters: dummy, repo, exec: dummy, repoDir: "/", base: "main", runner: "hosted", transport: async () => {} }).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_models", "plan", "relay", "route", "run_plan", "status"]);
});

test("route returns the spec shape and stores the task", async () => {
  const { call, repo } = await connect(['{"phase":"simple_edit","tier":"cheap"}']);
  const { body } = await call("route", { request: "renomeia uma variável" });
  assert.deepEqual({ ...body, task_id: undefined }, {
    task_id: undefined, phase: "simple_edit", tier: "cheap", model: "haiku-5-5", adapter: "claude-code", effort: "low", next: "run",
  });
  assert.equal(repo.getTask(body.task_id)!.tier, "cheap");
});

test("route with override_tier skips triage and strong goes to plan", async () => {
  const { call } = await connect(["nunca"]);
  const { body } = await call("route", { request: "x", override_tier: "strong" });
  assert.equal(body.tier, "strong");
  assert.equal(body.next, "plan");
});

test("plan returns steps with dependencies as seq numbers", async () => {
  const { call, repo } = await connect([JSON.stringify({ steps: [
    { tier: "mid", brief: "a", depends_on: [], files: ["x"] }, { tier: "mid", brief: "b", depends_on: [], files: ["x"] },
  ] })]);
  const task = repo.insertTask({ request: "r" });
  const { body } = await call("plan", { task_id: task.id });
  assert.deepEqual(body.steps.map((s: { depends_on: number[] }) => s.depends_on), [[], [1]]);
});

test("unknown task is an error result, not a crash", async () => {
  const { call } = await connect(["x"]);
  const r = await call("plan", { task_id: "nope" });
  assert.equal(r.error, true);
  assert.match(r.body, /unknown task/);
});

test("invalid input is rejected by the schema", async () => {
  const { call } = await connect(["x"]);
  assert.equal((await call("route", { request: "" })).error, true);
  assert.equal((await call("route", { request: "x", override_tier: "huge" })).error, true);
});

test("status sums cost and the strong baseline", async () => {
  const { call, repo } = await connect(["x"]);
  const task = repo.insertTask({ request: "r" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "b", tier: "mid", depends_on: [], files: [] });
  const at = repo.insertAttempt({ step_id: step.id, n: 1, adapter: "claude-code", model: "sonnet-5-5", tier: "mid", effort: "medium", runner: "hosted" });
  repo.finishAttempt(at.id, { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, est_cost_usd: 3 });
  const { body } = await call("status", { task_id: task.id });
  assert.equal(body.cost.actual_usd, 3);
  assert.equal(body.cost.all_strong_baseline_usd, 5);
  assert.equal(body.steps[0].attempts.length, 1);
  assert.equal((await call("status", {})).body.cost.actual_usd, 3);
});

test("check_models records availability and relay falls back when the bot is down", async () => {
  const { call } = await connect(["x"], async () => { throw new Error("offline"); });
  const models = (await call("check_models", {})).body;
  assert.equal(models.length, 5);
  assert.ok(models.every((m: { available: boolean }) => m.available));
  assert.deepEqual((await call("relay", { body: "oi" })).body, { channel: "claude", delivered: false });
});
