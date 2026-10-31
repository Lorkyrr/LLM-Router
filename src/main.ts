import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeAdapters } from "./adapters/registry.ts";
import { checkModels, recheckUnavailable } from "./catalog/check.ts";
import { flush, type Transport } from "./channel/relay.ts";
import { loadConfig } from "./config.ts";
import { realExec } from "./exec.ts";
import { makeLease } from "./runner/lease.ts";
import { makeServer } from "./server.ts";
import { defaultDbPath, openDb } from "./store/db.ts";
import { makeRepo } from "./store/repo.ts";

// Registrado em escopo de usuário, o servidor roda com o cwd do projeto aberto: config e scripts vêm da instalação.
const INSTALL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// Um runner por repositório alvo (conta pessoal não tem runner global): a instância é "owner-repo" do remote origin.
async function runnerInstance(cwd: string): Promise<string> {
  if (process.env.ROUTER_RUNNER) return process.env.ROUTER_RUNNER;
  const r = await realExec("git", ["remote", "get-url", "origin"], { cwd });
  const m = r.stdout.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (r.code !== 0 || !m) throw new Error(`cannot derive runner name from origin of ${cwd}; set ROUTER_RUNNER`);
  return `${m[1]}-${m[2]}`;
}

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;

// Transporte do grok bot ainda indefinido (spike pendente): falhar faz o relay cair no Claude, como no caso de borda 4.
const grokBot: Transport = async () => {
  throw new Error("grok bot transport not configured");
};

async function main() {
  const loaded = loadConfig(process.env.ROUTER_CONFIG ?? join(INSTALL_DIR, "config/router.yaml"));
  // ROUTER_LOCAL_TEST="npm run typecheck && npm test" liga o gate local sem copiar o catálogo; ROUTER_VERIFY_MODE=staged
  // também sobe o PR e o CI do GitHub depois do gate (padrão: local, sem GitHub).
  const localTest = process.env.ROUTER_LOCAL_TEST?.trim();
  const mode = (process.env.ROUTER_VERIFY_MODE ?? "local") as "local" | "staged";
  if (mode !== "local" && mode !== "staged") throw new Error(`ROUTER_VERIFY_MODE must be local or staged, got "${mode}"`);
  const cmds = localTest?.split("&&").map((c) => c.trim().split(/\s+/)).filter((c) => c[0]);
  const cfg = cmds?.length ? { ...loaded, verify: { ...loaded.verify, mode, local: { cmds, timeout_s: loaded.verify.local?.timeout_s ?? 1800 } } } : loaded;
  const dbPath = process.env.ROUTER_DB ?? defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = makeRepo(openDb(dbPath));
  const repoDir = process.env.ROUTER_REPO_DIR ?? process.cwd();
  // Fora de um repositório git (ou no modo local) não há runner a ligar: o servidor sobe sem lease em vez de cair.
  const lease = cfg.verify.mode === "local" ? undefined : await runnerInstance(repoDir).then(
    (instance) =>
      makeLease(realExec, { up: join(INSTALL_DIR, "ci/runner-up.sh"), down: join(INSTALL_DIR, "ci/runner-down.sh"), args: [instance] }),
    (e) => (console.error(e instanceof Error ? e.message : e), undefined),
  );
  const adapters = makeAdapters(realExec);

  // stdout é o canal MCP: todo log vai para stderr.
  const server = makeServer({
    cfg, adapters, repo, exec: realExec, runner: "self_hosted", base: process.env.ROUTER_BASE ?? "main", transport: grokBot,
    repoDir, lease,
  });
  await server.connect(new StdioServerTransport());

  // Handshake/diagnóstico podem ser feitos sem chamadas pagas.
  const automaticChecks = process.env.ROUTER_CHECK_MODELS !== "manual";
  if (automaticChecks) checkModels(cfg, adapters, repo).catch((e) => console.error("check_models:", e));
  setInterval(() => flush(repo, grokBot).catch((e) => console.error("flush:", e)), FLUSH_INTERVAL_MS).unref();
  if (automaticChecks) setInterval(() => recheckUnavailable(cfg, adapters, repo).catch((e) => console.error("recheck:", e)), RECHECK_INTERVAL_MS).unref();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
