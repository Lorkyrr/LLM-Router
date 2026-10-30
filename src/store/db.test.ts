import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";

test("openDb creates the five tables", () => {
  const db = openDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["attempts", "messages", "models", "steps", "tasks"]) assert.ok(names.includes(t), t);
});

test("openDb is idempotent on an existing database", () => {
  const db = openDb();
  assert.doesNotThrow(() => openDb(db));
});

test("every table has id, created_at and updated_at", () => {
  const db = openDb();
  for (const t of ["attempts", "messages", "models", "steps", "tasks"]) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
    for (const c of ["id", "created_at", "updated_at"]) assert.ok(cols.includes(c), `${t}.${c}`);
  }
});
