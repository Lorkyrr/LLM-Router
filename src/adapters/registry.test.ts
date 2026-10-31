import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAdapters } from "./registry.ts";
import { loadConfig } from "../config.ts";
import { triage } from "../triage/triage.ts";
import { makeRepo } from "../store/repo.ts";
import { openDb } from "../store/db.ts";
import { fakeExec, ok } from "../../test/fixtures/fake-exec.ts";

test("triage uses the registered Codex adapter with a read-only sandbox", async () => {
  const cfg = loadConfig(new URL("../../config/router.yaml", import.meta.url).pathname);
  cfg.triage.model = "gpt-6-luna";
  const stdout = [
    { type: "item.completed", item: { type: "agent_message", text: '{"phase":"simple_edit","tier":"cheap"}' } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const exec = fakeExec([{ when: (c) => c.cmd === "codex", reply: ok(stdout) }]);
  const result = await triage(cfg, makeAdapters(exec), "corrija o título", { cwd: "/repo", repo: makeRepo(openDb()) });
  assert.deepEqual(result, { phase: "simple_edit", tier: "cheap", effort: "low" });
  const args = exec.calls[0]!.args;
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6-luna");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});
