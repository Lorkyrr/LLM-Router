import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { DatabaseSync } from "node:sqlite";
import { makeRepo } from "./repo.ts";

test("openDb creates the five tables", () => {
  const db = openDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["attempts", "messages", "models", "steps", "tasks"]) assert.ok(names.includes(t), t);
});

test("openDb is idempotent on an existing database", () => {
  const db = openDb();
  assert.doesNotThrow(() => openDb(db));
});

test("openDb migrates old attempts without losing history and is repeatable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE attempts (id TEXT PRIMARY KEY, step_id TEXT); INSERT INTO attempts VALUES ('old', 'step')");
  openDb(db);
  openDb(db);
  const old = db.prepare("SELECT * FROM attempts WHERE id = 'old'").get()!;
  assert.equal(old.kind, "task");
  assert.equal(old.reason, null);
  assert.equal(old.step_id, "step");
});

test("upgrades legacy steps without losing data and persists per-item routing", () => {
  const db = openDb();
  for (const column of ["phase", "effort", "reason"]) db.exec(`ALTER TABLE steps DROP COLUMN ${column}`);
  const repo = makeRepo(db);
  const task = repo.insertTask({ request: "original" });
  const old = repo.insertStep({ task_id: task.id, seq: 1, brief: "original", tier: "mid", depends_on: [], files: [] });
  openDb(db);
  assert.equal(repo.getStep(old.id)?.brief, "original");
  assert.equal(repo.getStep(old.id)?.phase, null);
  const item = repo.insertStep({ task_id: task.id, seq: 2, brief: "revise", tier: "strong", phase: "integration", effort: "medium", reason: "contratos", depends_on: [old.id], files: [] });
  openDb(db);
  assert.deepEqual([repo.getStep(item.id)?.phase, repo.getStep(item.id)?.effort, repo.getStep(item.id)?.reason], ["integration", "medium", "contratos"]);
});

test("every table has id, created_at and updated_at", () => {
  const db = openDb();
  for (const t of ["attempts", "messages", "models", "steps", "tasks"]) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
    for (const c of ["id", "created_at", "updated_at"]) assert.ok(cols.includes(c), `${t}.${c}`);
  }
});

test("legacy steps gain a nullable private handoff without rewriting history", () => {
  const db = openDb();
  db.exec("ALTER TABLE steps DROP COLUMN handoff");
  const repo = makeRepo(db);
  const task = repo.insertTask({ request: "original" });
  const step = repo.insertStep({ task_id: task.id, seq: 1, brief: "original", tier: "mid", depends_on: [], files: [] });
  openDb(db);
  openDb(db);
  assert.equal(repo.getStep(step.id)!.handoff, null);
  const handoff = { step_id: step.id, brief: "private brief", diff: "private diff", findings: ["private finding"], model: "sol", risk: [], review: null };
  repo.updateStep(step.id, { handoff });
  assert.deepEqual(repo.getStep(step.id)!.handoff, handoff);
  assert.doesNotMatch(repo.exportHistory(), /private|handoff/);
});
