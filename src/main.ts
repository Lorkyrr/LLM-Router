import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClaudeCode } from "./adapters/claude-code.ts";
import { makeGrokBuild } from "./adapters/grok-build.ts";
import { checkModels, recheckUnavailable } from "./catalog/check.ts";
import { flush, type Transport } from "./channel/relay.ts";
import { loadConfig } from "./config.ts";
import { realExec } from "./exec.ts";
import { makeLease } from "./runner/lease.ts";
import { makeServer } from "./server.ts";
import { openDb } from "./store/db.ts";
import { makeRepo } from "./store/repo.ts";

// Um runner por repositório alvo (conta pessoal não tem runner global): a instância é "owner-repo".
const runnerInstance = process.env.ROUTER_RUNNER ?? "Lorkyrr-LLM-Router";

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;

// Transporte do grok bot ainda indefinido (spike pendente): falhar faz o relay cair no Claude, como no caso de borda 4.
const grokBot: Transport = async () => {
  throw new Error("grok bot transport not configured");
};

async function main() {
  const cfg = loadConfig(process.env.ROUTER_CONFIG ?? "config/router.yaml");
  const repo = makeRepo(openDb(process.env.ROUTER_DB ?? "router.db"));
  const adapters = { "claude-code": makeClaudeCode(realExec), "grok-build": makeGrokBuild(realExec) };

  // stdout é o canal MCP: todo log vai para stderr.
  const server = makeServer({
    cfg, adapters, repo, exec: realExec, runner: "self_hosted", base: "main", transport: grokBot,
    repoDir: process.env.ROUTER_REPO_DIR ?? process.cwd(),
    lease: makeLease(realExec, { up: "ci/runner-up.sh", down: "ci/runner-down.sh", args: [runnerInstance] }),
  });
  await server.connect(new StdioServerTransport());

  checkModels(cfg, adapters, repo).catch((e) => console.error("check_models:", e));
  setInterval(() => flush(repo, grokBot).catch((e) => console.error("flush:", e)), FLUSH_INTERVAL_MS).unref();
  setInterval(() => recheckUnavailable(cfg, adapters, repo).catch((e) => console.error("recheck:", e)), RECHECK_INTERVAL_MS).unref();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
