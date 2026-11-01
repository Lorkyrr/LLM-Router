import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Sem FK e sem apagar linhas: o histórico alimenta o relatório de custo; o fim de vida é o campo status.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  phase TEXT,
  tier TEXT,
  status TEXT NOT NULL,
  source_channel TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  brief TEXT NOT NULL,
  tier TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  files TEXT NOT NULL,
  branch TEXT,
  pr_number INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_task_id ON steps(task_id);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  effort TEXT NOT NULL,
  runner TEXT NOT NULL,
  ci_result TEXT,
  failure_reason TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  est_cost_usd REAL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_step_id ON attempts(step_id);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  tier TEXT NOT NULL,
  preference INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  quota_state TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages(created_at) WHERE delivered = 0;
`;

// Servidor MCP e hook compartilham o mesmo arquivo, qualquer que seja o projeto aberto.
export const defaultDbPath = (): string => join(homedir(), ".local/share/llm-router/router.db");

export function openDb(target: string | DatabaseSync = ":memory:"): DatabaseSync {
  const db = typeof target === "string" ? new DatabaseSync(target) : target;
  // O hook do claude-code grava no mesmo arquivo que o servidor: WAL + espera evitam "database is locked".
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Migração aditiva também em bancos anteriores: preserva o histórico e tolera processos concorrentes.
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(attempts)").all().map((r) => r.name);
    if (!columns.includes("kind")) db.exec("ALTER TABLE attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
    if (!columns.includes("reason")) db.exec("ALTER TABLE attempts ADD COLUMN reason TEXT");
    const stepColumns = new Set(db.prepare("PRAGMA table_info(steps)").all().map((r) => r.name));
    for (const column of ["phase", "effort", "reason", "role"]) {
      if (!stepColumns.has(column)) db.exec(`ALTER TABLE steps ADD COLUMN ${column} TEXT`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return db;
}
