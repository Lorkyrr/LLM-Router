import type { Exec } from "../exec.ts";
import { makeCliAdapter, ZERO_USAGE, type Adapter, type Parsed } from "./types.ts";

// usage.input_tokens inclui cached_input_tokens (e, assumido, cache_write_input_tokens) no Codex. O store usa categorias exclusivas.
function parse(stdout: string): Parsed | undefined {
  const usage = { ...ZERO_USAGE };
  let text = "";
  let completed = false;
  let error = "";
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  try {
    for (const line of stdout.split("\n").filter((s) => s.trim())) {
      const e = JSON.parse(line);
      if (!e || typeof e !== "object") return undefined;
      if (e.type === "turn.started") completed = false;
      if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") text = e.item.text;
      if (e.type === "turn.completed") {
        const u = e.usage;
        const written = u?.cache_write_input_tokens ?? 0;
        if (!u || !count(u.input_tokens) || !count(u.cached_input_tokens) || !count(u.output_tokens) || !count(written) || u.cached_input_tokens + written > u.input_tokens) return undefined;
        usage.input_tokens += u.input_tokens - u.cached_input_tokens - written;
        usage.cache_read_tokens += u.cached_input_tokens;
        usage.cache_write_tokens += written;
        usage.output_tokens += u.output_tokens;
        completed = true;
      }
      if (e.type === "turn.failed" || e.type === "error") {
        completed = false;
        error = typeof e.error?.message === "string" ? e.error.message : typeof e.message === "string" ? e.message : "Codex execution failed";
      }
    }
    // CLI não expõe fatura; o custo é estimado pela tabela de preços.
    return { text: completed ? text : error || "Codex stream ended without turn.completed", is_error: !completed, usage, cost_usd: null };
  } catch {
    return undefined;
  }
}

export function makeCodex(exec: Exec): Adapter {
  return makeCliAdapter({
    bin: "codex",
    args: (i) => [
      "exec", "--json", "--ephemeral", "--ignore-user-config",
      "--model", i.model,
      "--sandbox", i.readOnly ? "read-only" : "workspace-write",
      "--config", 'approval_policy="never"',
      "--config", `model_reasoning_effort=${JSON.stringify(i.effort)}`,
      // Pings rodam no tmpdir; a execução real continua exigindo repositório Git.
      ...(i.readOnly ? ["--skip-git-repo-check"] : []),
      "--", i.prompt,
    ],
    parse,
  }, exec);
}
