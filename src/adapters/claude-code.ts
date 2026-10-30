import type { Exec } from "../exec.ts";
import { makeCliAdapter, num, type Parsed } from "./types.ts";

export function makeClaudeCode(exec: Exec, permissionMode = "acceptEdits") {
  return makeCliAdapter(
    {
      bin: "claude",
      args: (i) => [
        "-p", i.prompt,
        "--model", i.model,
        "--effort", i.effort,
        "--output-format", "json",
        "--no-session-persistence",
        "--permission-mode", permissionMode,
      ],
      parse(stdout): Parsed | undefined {
        try {
          const j = JSON.parse(stdout);
          const u = j.usage ?? {};
          return {
            text: typeof j.result === "string" ? j.result : "",
            is_error: j.is_error === true,
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
