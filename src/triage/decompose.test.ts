import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { ZERO_USAGE, type Adapter, type RunInput } from "../adapters/types.ts";
import { decompose } from "./decompose.ts";

const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
function setup(text = "invalid") {
  const calls: RunInput[] = [];
  const adapter: Adapter = {
    async run(input) {
      calls.push(input);
      return { ok: true, text, usage: ZERO_USAGE, cost_usd: null, quota_exhausted: false };
    },
    async ping() { return { available: true, quota_state: "ok" }; },
  };
  return { calls, adapters: { "claude-code": adapter, codex: adapter, "grok-build": adapter }, repo: makeRepo(openDb()) };
}

test("Portuguese mixed list routes each item and preserves a sequential barrier", async () => {
  const s = setup();
  const out = await decompose(cfg, s.adapters,
    "1. Renomeie o título em README.md\n2. Planeje a arquitetura de autenticação\n3. Enquanto isso, implemente testes de cache\n4. Depois, implemente a API de login", { cwd: "/w", repo: s.repo });
  assert.ok(out);
  assert.deepEqual(out.map((x) => x.phase), ["simple_edit", "planning", "implementing", "implementing"]);
  assert.deepEqual(out.map((x) => x.depends_on), [[], [], [], [1, 2, 3]]);
  assert.deepEqual(out.map((x) => x.effort), ["low", "high", "medium", "medium"]);
  assert.equal(s.calls.length, 0);
});

test("unnumbered prose and bullet tasks split without splitting noun conjunctions", async () => {
  for (const request of [
    "Renomeie o título e também planeje a arquitetura; enquanto isso, implemente testes de cache",
    "- Renomeie o título\n- Planeje a arquitetura\n- Implemente testes de cache",
    "Renomeie o título e implemente testes de cache e planeje a arquitetura",
  ]) {
    const s = setup();
    assert.equal((await decompose(cfg, s.adapters, request, { cwd: "/w", repo: s.repo }))?.length, 3);
    assert.equal(s.calls.length, 0);
  }
  const s = setup();
  assert.equal(await decompose(cfg, s.adapters, "Renomeie os campos nome e sobrenome", { cwd: "/w", repo: s.repo }), null);
});

test("ambiguous delegation uses cheap low even when triage is configured strong", async () => {
  const s = setup(JSON.stringify({ steps: [
    { phase: "simple_edit", brief: "Atualize o texto", depends_on: [], files: [] },
    { phase: "implementing", brief: "Implemente cache", depends_on: [1], files: [] },
  ] }));
  const custom = { ...cfg, triage: { model: "opus-5-5", effort: "high" as const } };
  const out = await decompose(custom, s.adapters, "Cuide do texto e também daquela parte do cache", { cwd: "/w", repo: s.repo });
  assert.equal(out?.length, 2);
  assert.equal(s.calls[0]?.model, "claude-haiku-5-5");
  assert.equal(s.calls[0]?.effort, "low");
  assert.equal(s.calls[0]?.readOnly, true);
});

test("invalid dependency and malformed fallback never persist or escalate", async () => {
  const s = setup(JSON.stringify({ steps: [{ phase: "simple_edit", brief: "x", depends_on: [1], files: [] }] }));
  await assert.rejects(() => decompose(cfg, s.adapters, "Cuide de A e também B", { cwd: "/w", repo: s.repo }), /invalid plan/);
  assert.equal(s.calls.length, 2);
  assert.ok(s.calls.every((c) => c.effort === "low" && c.model === "claude-haiku-5-5"));
});

test("planner rejects missing, malformed, self and future dependencies", async () => {
  for (const depends_on of [undefined, null, "1", [0], [-1], [0.5], ["1"], [1], [2]]) {
    const s = setup(JSON.stringify({ steps: [
      { phase: "implementing", brief: "Implemente cache", depends_on, files: [] },
    ] }));
    await assert.rejects(() => decompose(cfg, s.adapters, "Cuide de A e também B", { cwd: "/w", repo: s.repo }), /invalid plan/);
    assert.equal(s.calls.length, 2);
  }
});

test("planner only returns dependencies on earlier items, including shared files", async () => {
  const s = setup(JSON.stringify({ steps: [
    { phase: "planning", brief: "Planeje a arquitetura", depends_on: [], files: [] },
    { phase: "implementing", brief: "Implemente cache", depends_on: [1], files: ["src/cache.ts"] },
    { phase: "integration", brief: "Integre cache", depends_on: [1, 1], files: ["src/cache.ts"] },
  ] }));
  const out = await decompose(cfg, s.adapters, "Cuide de A e também B", { cwd: "/w", repo: s.repo });
  assert.ok(out);
  assert.deepEqual(out.map((item) => item.depends_on), [[], [1], [1, 2]]);
  for (const [index, item] of out.entries()) {
    assert.ok(item.depends_on.every((dependency) => Number.isInteger(dependency) && dependency > 0 && dependency <= index));
  }
});

test("inline numbering separates four tasks and shared files force ordering", async () => {
  const s = setup();
  const out = await decompose(cfg, s.adapters, "1) Renomeie o título em README.md 2) Planeje a arquitetura 3) Atualize o texto em README.md 4) Implemente testes de cache", { cwd: "/w", repo: s.repo });
  assert.equal(out?.length, 4);
  assert.deepEqual(out?.map((x) => x.depends_on), [[], [], [1], []]);
  assert.equal(s.calls.length, 0);
});

test("sentences and comma-separated commands are distinct tasks", async () => {
  for (const request of [
    "Renomeie o título. Implemente testes. Planeje a arquitetura",
    "Renomeie o título, implemente testes, planeje a arquitetura",
    "Corrija o typo, adicione testes e atualize o texto",
  ]) {
    const s = setup();
    const out = await decompose(cfg, s.adapters, request, { cwd: "/w", repo: s.repo });
    assert.equal(out?.length, 3);
    assert.equal(s.calls.length, 0);
  }
});

test("complexity words inside an edit target do not promote it to strong", async () => {
  const s = setup();
  const out = await decompose(cfg, s.adapters, "Renomeie a variável planejamento e também ajuste o texto de integração; implemente testes de planejamento", { cwd: "/w", repo: s.repo });
  assert.deepEqual(out?.map((s) => s.tier), ["cheap", "cheap", "mid"]);
  assert.equal(s.calls.length, 0);
});

test("implicit references and common context defer dependency decisions to cheap", async () => {
  const s = setup(JSON.stringify({ steps: [
    { phase: "planning", brief: "Planeje a arquitetura", depends_on: [], files: [] },
    { phase: "implementing", brief: "Implemente a arquitetura planejada", depends_on: [1], files: [] },
  ] }));
  const out = await decompose(cfg, s.adapters, "Planeje a arquitetura e também implemente essa arquitetura", { cwd: "/w", repo: s.repo });
  assert.deepEqual(out?.[1]?.depends_on, [1]);
  assert.equal(s.calls.length, 1);
});

test("references to a plan or explicit item override additive independence", async () => {
  for (const request of [
    "Planeje a arquitetura e implemente o plano",
    "1. Planeje a arquitetura\n2. Implemente a API conforme o plano\n3. Renomeie o título",
    "Renomeie o título e também implemente a API após o item 1",
  ]) {
    const s = setup(JSON.stringify({ steps: [
      { phase: "planning", brief: "Planeje a arquitetura", depends_on: [], files: [] },
      { phase: "implementing", brief: "Implemente conforme o plano", depends_on: [1], files: [] },
    ] }));
    const out = await decompose(cfg, s.adapters, request, { cwd: "/w", repo: s.repo });
    assert.deepEqual(out?.[1]?.depends_on, [1]);
    assert.equal(s.calls.length, 1);
  }
});
