// Gasta tokens reais (um Haiku por caso). Uso: node --import tsx test/bench-triage.ts [judge-cases.json]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { makeAdapters } from "../src/adapters/registry.ts";
import { loadConfig, type Effort } from "../src/config.ts";
import { realExec } from "../src/exec.ts";
import { openDb } from "../src/store/db.ts";
import { makeRepo } from "../src/store/repo.ts";
import { isCorrect } from "../src/triage/bench.ts";
import { triage } from "../src/triage/triage.ts";

type Case = { id: string; kind: string; message: string; context?: string; ok: Effort[]; holdout?: boolean };

const TARGET = 0.9;
const CONCURRENCY = 4;
const casesPath = process.argv[2] ?? `${homedir()}/.claude/plugins/cache/effortless/effortless/1.72.0/bench/judge-cases.json`;
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8")).cases;
const cfg = loadConfig(new URL("../config/router.yaml", import.meta.url).pathname);
// Banco em memória: o benchmark não deve tocar no estado real de disponibilidade dos modelos.
const repo = makeRepo(openDb());
const adapters = makeAdapters(realExec);

type Result = Case & { predicted: string; right: boolean };
const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < cases.length) {
      const c = cases[next++]!;
      const request = c.context ? `Conversa até aqui:\n${c.context}\n\nNova mensagem: ${c.message}` : c.message;
      const predicted = await triage(cfg, adapters, request, { cwd: tmpdir(), repo }).then((t) => t.tier, (e) => `error: ${e.message}`);
      results.push({ ...c, predicted, right: isCorrect(predicted as never, c.ok) });
    }
  }),
);

const pct = (rs: Result[]) => `${rs.filter((r) => r.right).length}/${rs.length} (${((100 * rs.filter((r) => r.right).length) / rs.length).toFixed(0)}%)`;
const kinds = [...new Set(results.map((r) => r.kind))].sort();
console.log(`total ${pct(results)}   holdout ${pct(results.filter((r) => r.holdout))}`);
for (const kind of kinds) console.log(`  ${kind.padEnd(16)} ${pct(results.filter((r) => r.kind === kind))}`);
const wrong = results.filter((r) => !r.right).sort((a, b) => a.id.localeCompare(b.id));
console.log("errors:");
for (const r of wrong) console.log(`  ${r.id} [${r.kind}] ok=${r.ok.join("/")} got=${r.predicted} :: ${r.message.slice(0, 70)}`);
writeFileSync(new URL("./bench-triage.last.json", import.meta.url), JSON.stringify(results, null, 2));
process.exit(results.filter((r) => r.right).length / results.length >= TARGET ? 0 : 1);
