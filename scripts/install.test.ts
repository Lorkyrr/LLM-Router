import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_TOOLS = ["bash", "env", "python3", "git", "node", "dirname", "rm", "cat", "sh"];

let tmp: string, home: string, root: string, bin: string;

function which(tool: string): string | undefined {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = join(d, tool);
    if (existsSync(p)) return p;
  }
}
function fake(name: string, body: string) {
  const p = join(bin, name);
  rmSync(p, { force: true });
  writeFileSync(p, "#!/bin/bash\n" + body + "\n");
  chmodSync(p, 0o755);
}
function addCli(name: string) {
  if (name === "claude") {
    fake("claude", [
      'S="$HOME/.fake-claude-mcp"',
      'case "$2" in',
      '  get) [ -f "$S" ];;',
      '  add) echo added > "$S";;',
      '  remove) rm -f "$S";;',
      "esac",
    ].join("\n"));
  } else fake(name, "exit 0");
}
function run(script: string, args: string[] = []) {
  return spawnSync("bash", [join(root, "scripts", script), ...args], {
    encoding: "utf8",
    env: { PATH: bin, HOME: home, XDG_STATE_HOME: join(home, ".state") },
  });
}
// Snapshot do conteúdo do HOME, ignorando backups.
function snap(dir = home, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n), r = join(rel, n);
    if (n.includes(".llm-router.bak-")) continue;
    if (statSync(p).isDirectory()) Object.assign(out, snap(p, r));
    else out[r] = readFileSync(p, "utf8");
  }
  return out;
}
function backups(): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.includes(".llm-router.bak-")) found.push(join(d, e.name));
    }
  };
  walk(home);
  return found;
}
const read = (rel: string) => readFileSync(join(home, rel), "utf8");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "router-inst-"));
  home = join(tmp, "home"); root = join(tmp, "root"); bin = join(tmp, "bin");
  mkdirSync(home); mkdirSync(bin); mkdirSync(root);
  for (const d of ["scripts", "hooks", "bin"]) {
    if (existsSync(join(SRC, d))) cpSync(join(SRC, d), join(root, d), { recursive: true });
  }
  writeFileSync(join(root, "package-lock.json"), "{}");
  for (const t of SYSTEM_TOOLS) {
    const w = which(t);
    if (w) symlinkSync(w, join(bin, t));
  }
  // npm falso: cria node_modules sem rede.
  fake("npm", 'echo "$@" >> "' + tmp + '/npm.log"; mkdir -p node_modules; echo "{}" > node_modules/.package-lock.json');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("dependência ausente falha e não escreve nada", () => {
  rmSync(join(bin, "git"));
  addCli("codex");
  const r = run("install.sh");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git/);
  assert.deepEqual(snap(), {});
});

test("node < 24 falha", () => {
  rmSync(join(bin, "node"));
  fake("node", '[ "$1" = "-p" ] && echo 20 || echo v20.0.0');
  const r = run("install.sh");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /node >= 24/);
});

test("gh ausente é só aviso", () => {
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gh ausente/);
});

test("sem CLIs: nada registrado", () => {
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nenhum CLI/);
  assert.deepEqual(snap(), {});
});

test("--dry-run não altera nada", () => {
  addCli("codex"); addCli("claude"); addCli("gemini");
  const r = run("install.sh", ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.deepEqual(snap(), {});
  assert.equal(existsSync(join(root, "node_modules")), false);
  assert.equal(existsSync(join(tmp, "npm.log")), false);
});

test("argumento inválido sai com 2", () => {
  assert.equal(run("install.sh", ["--x"]).status, 2);
  assert.equal(run("uninstall.sh", ["--x"]).status, 2);
});

test("registra só nos CLIs presentes", () => {
  addCli("codex"); addCli("gemini");
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(".codex/config.toml"), /\[mcp_servers\.llm-router\]/);
  assert.ok(JSON.parse(read(".gemini/settings.json")).mcpServers["llm-router"]);
  assert.equal(existsSync(join(home, ".qwen")), false);
  assert.equal(existsSync(join(home, ".fake-claude-mcp")), false);
  assert.match(read(".codex/AGENTS.md"), /run_plan/);
  assert.match(read(".codex/hooks.json"), /router-reminder\.py/);
});

test("claude usa a CLI e grava instruções e hook", () => {
  addCli("claude");
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, ".fake-claude-mcp")));
  assert.match(read(".claude/CLAUDE.md"), /llm-router/);
  const s = JSON.parse(read(".claude/settings.json"));
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /router-reminder\.py/);
});

test("grok é detectado mas não alterado", () => {
  addCli("grok");
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /grok/);
  assert.deepEqual(snap(), {});
});

test("idempotência: segunda execução não muda nada nem cria backup", () => {
  addCli("claude"); addCli("codex"); addCli("opencode"); addCli("goose");
  assert.equal(run("install.sh").status, 0);
  const first = snap(), bak = backups().length;
  const r = run("install.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(), first);
  assert.equal(backups().length, bak);
  assert.match(r.stdout, /já registrado/);
  assert.equal(readFileSync(join(tmp, "npm.log"), "utf8").trim().split("\n").length, 1);
});

test("backup preserva o original e o conteúdo existente é mantido", () => {
  addCli("codex");
  mkdirSync(join(home, ".codex"));
  const orig = 'model = "x"\n';
  writeFileSync(join(home, ".codex/config.toml"), orig);
  writeFileSync(join(home, ".codex/AGENTS.md"), "# meu\n");
  assert.equal(run("install.sh").status, 0);
  const b = backups().map((f) => readFileSync(f, "utf8"));
  assert.ok(b.includes(orig));
  assert.ok(b.includes("# meu\n"));
  assert.ok(read(".codex/config.toml").startsWith(orig));
  assert.ok(read(".codex/AGENTS.md").startsWith("# meu\n"));
});

test("entrada externa existente não é tocada", () => {
  addCli("codex");
  mkdirSync(join(home, ".codex"));
  const t = '[mcp_servers.llm-router]\ncommand = "outro"\n';
  writeFileSync(join(home, ".codex/config.toml"), t);
  const r = run("install.sh");
  assert.match(r.stdout, /externa/);
  assert.equal(read(".codex/config.toml"), t);
});

test("uninstall reverte tudo, preservando conteúdo prévio", () => {
  for (const c of ["claude", "codex", "gemini", "qwen", "cursor-agent", "copilot", "opencode", "goose"]) addCli(c);
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".codex/config.toml"), 'model = "x"\n');
  writeFileSync(join(home, ".codex/AGENTS.md"), "# meu\n");
  const gem = JSON.stringify({ theme: "dark" }, null, 2) + "\n";
  writeFileSync(join(home, ".gemini/settings.json"), gem);
  const before = snap();
  assert.equal(run("install.sh").status, 0);
  assert.notDeepEqual(snap(), before);
  const r = run("uninstall.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(), before);
  assert.equal(existsSync(join(root, "node_modules")), false);
  assert.equal(run("uninstall.sh").status, 0);
});

test("uninstall --dry-run não altera nada", () => {
  addCli("claude"); addCli("codex");
  run("install.sh");
  const before = snap();
  const r = run("uninstall.sh", ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.deepEqual(snap(), before);
  assert.ok(existsSync(join(root, "node_modules")));
});

test("uninstall mantém node_modules que já existia", () => {
  mkdirSync(join(root, "node_modules"));
  const lock = join(root, "node_modules/.package-lock.json");
  writeFileSync(lock, "{}");
  const future = new Date(Date.now() + 60_000);
  utimesSync(lock, future, future);
  addCli("codex");
  assert.equal(run("install.sh").status, 0);
  assert.equal(run("uninstall.sh").status, 0);
  assert.ok(existsSync(join(root, "node_modules")));
});
