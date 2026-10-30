import { tmpdir } from "node:os";
import type { Effort } from "../config.ts";
import type { Exec } from "../exec.ts";
import type { Usage } from "../policy/cost.ts";

export type AdapterName = "claude-code" | "grok-build";
export type RunInput = { model: string; effort: Effort; prompt: string; cwd: string; timeoutMs?: number };
export type RunResult = {
  ok: boolean;
  text: string;
  usage: Usage;
  cost_usd: number | null;
  quota_exhausted: boolean;
  error?: string;
};
export type Availability = { available: boolean; quota_state: "ok" | "exhausted" | "error" };
export type Adapter = {
  run(input: RunInput): Promise<RunResult>;
  ping(model: string): Promise<Availability>;
};

export type Parsed = { text: string; is_error: boolean; usage: Usage; cost_usd: number | null };

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

// Heurística sobre a mensagem do CLI: nenhum dos dois expõe um código estruturado para "sem cota".
const QUOTA = /usage limit|rate.?limit|quota|limit reached|credit balance|out of credits/i;

// O prompt vai como argumento (spawn sem shell, sem problema de aspas); briefs de passo são curtos.
const PING_PROMPT = "responda apenas: ok";

export type CliSpec = {
  bin: string;
  args(input: RunInput): string[];
  parse(stdout: string): Parsed | undefined;
};

export function makeCliAdapter(spec: CliSpec, exec: Exec): Adapter {
  async function run(input: RunInput): Promise<RunResult> {
    const r = await exec(spec.bin, spec.args(input), { cwd: input.cwd, timeoutMs: input.timeoutMs });
    const parsed = spec.parse(r.stdout);
    if (!parsed) {
      const error = r.stderr || r.stdout.slice(0, 200) || `exit ${r.code}`;
      return { ok: false, text: "", usage: ZERO_USAGE, cost_usd: null, quota_exhausted: QUOTA.test(error), error };
    }
    const ok = r.code === 0 && !parsed.is_error;
    const quota_exhausted = !ok && QUOTA.test(`${parsed.text} ${r.stderr}`);
    return {
      ok,
      text: parsed.text,
      usage: parsed.usage,
      cost_usd: parsed.cost_usd,
      quota_exhausted,
      error: ok ? undefined : parsed.text || r.stderr || `exit ${r.code}`,
    };
  }

  return {
    run,
    async ping(model) {
      const r = await run({ model, effort: "low", prompt: PING_PROMPT, cwd: tmpdir() });
      return { available: r.ok, quota_state: r.ok ? "ok" : r.quota_exhausted ? "exhausted" : "error" };
    },
  };
}

export const num = (v: unknown): number => (typeof v === "number" ? v : 0);
