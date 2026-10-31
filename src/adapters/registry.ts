import type { Exec } from "../exec.ts";
import { makeClaudeCode } from "./claude-code.ts";
import { makeCodex } from "./codex.ts";
import { makeGrokBuild } from "./grok-build.ts";
import type { Adapter, AdapterName } from "./types.ts";

export const makeAdapters = (exec: Exec): Record<AdapterName, Adapter> => ({
  "claude-code": makeClaudeCode(exec),
  "grok-build": makeGrokBuild(exec),
  codex: makeCodex(exec),
});
