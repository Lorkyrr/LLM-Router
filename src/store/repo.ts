import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { Effort, Phase, Tier } from "../config.ts";

export type TaskStatus = "queued" | "planning" | "running" | "done" | "failed" | "waiting_quota";
export type StepStatus = "pending" | "running" | "done" | "failed" | "waiting_quota";
export type Runner = "self_hosted" | "hosted";
export type Channel = "grok_bot" | "claude";

type Stamps = { id: string; created_at: string; updated_at: string };
export type Task = Stamps & {
  request: string; phase: Phase | null; tier: Tier | null; status: TaskStatus; source_channel: string | null;
};
// depends_on guarda ids de passos do mesmo task
export type Step = Stamps & {
  task_id: string; seq: number; brief: string; tier: Tier; depends_on: string[]; files: string[];
  branch: string | null; pr_number: number | null; status: StepStatus;
};
export type Attempt = Stamps & {
  step_id: string; n: number; adapter: string; model: string; tier: Tier; effort: Effort; runner: Runner;
  ci_result: string | null; failure_reason: string | null;
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null;
  est_cost_usd: number | null; started_at: string; finished_at: string | null;
};
export type ModelRow = Stamps & {
  name: string; adapter: string; tier: Tier; preference: number; available: boolean;
  quota_state: string | null; checked_at: string | null;
};
export type Message = Stamps & {
  direction: "in" | "out"; channel: Channel; body: string; delivered: boolean; delivered_at: string | null; task_id: string | null;
};
export type TierUsage = {
  attempts: number; input_tokens: number; output_tokens: number; cache_read_tokens: number;
  cache_write_tokens: number; est_cost_usd: number;
};

type Row = Record<string, SQLOutputValue>;
const sqlValue = (v: unknown): SQLInputValue =>
  v === undefined || v === null ? null : typeof v === "boolean" ? Number(v) : (v as SQLInputValue);
const json = (v: unknown): string => JSON.stringify(v);

export function makeRepo(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
  function insert(table: string, fields: Record<string, unknown>): Stamps & Row {
    const stamp = now();
    const row = { id: randomUUID(), ...fields, created_at: stamp, updated_at: stamp };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
      ...cols.map((c) => sqlValue((row as Record<string, unknown>)[c])),
    );
    return byId(table, row.id) as Stamps & Row;
  }

  function update(table: string, id: string, fields: Record<string, unknown>): void {
    const all = { ...fields, updated_at: now() };
    const cols = Object.keys(all);
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(
      ...cols.map((c) => sqlValue(all[c as keyof typeof all])),
      id,
    );
  }

  const byId = (table: string, id: string): Row | undefined =>
    db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

  const toStep = (r: Row): Step =>
    ({ ...r, depends_on: JSON.parse(String(r.depends_on)), files: JSON.parse(String(r.files)) }) as unknown as Step;
  const toModel = (r: Row): ModelRow => ({ ...r, available: r.available === 1 }) as unknown as ModelRow;
  const toMessage = (r: Row): Message => ({ ...r, delivered: r.delivered === 1 }) as unknown as Message;

  return {
    insertTask: (t: { request: string; phase?: Phase; tier?: Tier; source_channel?: string }): Task =>
      insert("tasks", { ...t, status: "queued" }) as unknown as Task,
    getTask: (id: string): Task | undefined => byId("tasks", id) as unknown as Task | undefined,
    updateTask: (id: string, patch: Partial<Pick<Task, "phase" | "tier" | "status">>) => update("tasks", id, patch),

    insertStep: (s: {
      task_id: string; seq: number; brief: string; tier: Tier; depends_on: string[]; files: string[];
    }): Step => toStep(insert("steps", { ...s, depends_on: json(s.depends_on), files: json(s.files), status: "pending" })),
    getStep: (id: string): Step | undefined => {
      const r = byId("steps", id);
      return r && toStep(r);
    },
    listSteps: (taskId: string): Step[] =>
      db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY seq").all(taskId).map(toStep),
    updateStep: (id: string, patch: Partial<Pick<Step, "branch" | "pr_number" | "status">>) => update("steps", id, patch),

    insertAttempt: (a: {
      step_id: string; n: number; adapter: string; model: string; tier: Tier; effort: Effort; runner: Runner;
    }): Attempt => insert("attempts", { ...a, started_at: now() }) as unknown as Attempt,
    finishAttempt: (
      id: string,
      r: Partial<Pick<Attempt, "ci_result" | "failure_reason" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "est_cost_usd">>,
    ) => update("attempts", id, { ...r, finished_at: now() }),
    listAttempts: (stepId: string): Attempt[] =>
      db.prepare("SELECT * FROM attempts WHERE step_id = ? ORDER BY n").all(stepId) as unknown as Attempt[],
    usageByTier: (): Partial<Record<Tier, TierUsage>> => {
      const rows = db
        .prepare(
          `SELECT tier, COUNT(*) AS attempts,
             COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
             COALESCE(SUM(est_cost_usd),0) AS est_cost_usd
           FROM attempts WHERE finished_at IS NOT NULL GROUP BY tier`,
        )
        .all() as unknown as Array<TierUsage & { tier: Tier }>;
      return Object.fromEntries(rows.map(({ tier, ...u }) => [tier, { ...u }]));
    },

    upsertModel: (m: { name: string; adapter: string; tier: Tier; preference: number }) => {
      const stamp = now();
      db.prepare(
        `INSERT INTO models (id, name, adapter, tier, preference, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET adapter = excluded.adapter, tier = excluded.tier,
           preference = excluded.preference, updated_at = excluded.updated_at`,
      ).run(randomUUID(), m.name, m.adapter, m.tier, m.preference, stamp, stamp);
    },
    setAvailability: (name: string, s: { available: boolean; quota_state?: string }) => {
      const stamp = now();
      db.prepare("UPDATE models SET available = ?, quota_state = ?, checked_at = ?, updated_at = ? WHERE name = ?").run(
        Number(s.available), sqlValue(s.quota_state), stamp, stamp, name,
      );
    },
    listModels: (): ModelRow[] => db.prepare("SELECT * FROM models ORDER BY tier, preference").all().map(toModel),

    insertMessage: (m: { direction: "in" | "out"; channel: Channel; body: string; task_id?: string }): Message =>
      toMessage(insert("messages", { ...m, delivered: false })),
    listUndelivered: (): Message[] =>
      db.prepare("SELECT * FROM messages WHERE delivered = 0 ORDER BY created_at").all().map(toMessage),
    setMessageChannel: (id: string, channel: Channel) => update("messages", id, { channel }),
    markDelivered: (id: string) => update("messages", id, { delivered: true, delivered_at: now() }),
  };
}

export type Repo = ReturnType<typeof makeRepo>;
