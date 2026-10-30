import type { Exec } from "../exec.ts";
import { makeCliAdapter, num, type Parsed } from "./types.ts";

export function makeGrokBuild(exec: Exec, permissionMode = "acceptEdits") {
  return makeCliAdapter(
    {
      bin: "grok",
      args: (i) => [
        "-p", i.prompt,
        "-m", i.model,
        "--reasoning-effort", i.effort,
        "--output-format", "json",
        "--permission-mode", permissionMode,
      ],
      parse(stdout): Parsed | undefined {
        try {
          const j = JSON.parse(stdout);
          const u = j.usage ?? {};
          return {
            text: typeof j.text === "string" ? j.text : "",
            is_error: j.stopReason === "error",
            usage: {
              input_tokens: num(u.input_tokens),
              output_tokens: num(u.output_tokens),
              cache_read_tokens: num(u.cache_read_input_tokens),
              cache_write_tokens: num(u.cache_creation_input_tokens),
            },
            cost_usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
          };
        } catch {
          return undefined;
        }
      },
    },
    exec,
  );
}
