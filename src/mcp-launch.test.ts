import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const nonblocking of [false, true]) test(`MCP handshake with nonblocking stdin=${nonblocking}`, { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-mcp-test-"));
  const transport = new StdioClientTransport({
    command: "python3",
    args: nonblocking ? ["-c", `import os,runpy,sys;os.set_blocking(0,False);sys.argv=[${JSON.stringify(fileURLToPath(new URL("../bin/router-mcp.py", import.meta.url)))},'--node',${JSON.stringify(process.execPath)}];runpy.run_path(sys.argv[0],run_name='__main__')`]
      : [fileURLToPath(new URL("../bin/router-mcp.py", import.meta.url)), "--node", process.execPath],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ROUTER_DB: join(dir, "router.db"), ROUTER_CHECK_MODELS: "manual" },
    cwd: dir, // Import tsx must work outside the installation directory.
    stderr: "pipe",
  });
  const client = new Client({ name: "router-launch-test", version: "1" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("route"));
    assert.ok(names.includes("run_plan"));
    const status = await client.callTool({ name: "status", arguments: {} });
    assert.equal(status.isError, undefined);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP launcher kills a worker that ignores SIGTERM after stdin closes", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-launch-exit-"));
  const worker = join(dir, "worker");
  writeFileSync(worker, "#!/usr/bin/python3\nimport signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('READY',flush=True)\nwhile True: time.sleep(0.1)\n", { mode: 0o700 });
  const child = spawn("python3", [fileURLToPath(new URL("../bin/router-mcp.py", import.meta.url)), "--node", worker], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => { child.stdin.end(); resolve(); });
    });
    const result = await Promise.race([closed, new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 6500);
      timer.unref();
    })]);
    assert.notEqual(result, "timeout", "worker must be killed even while stdout remains open");
    assert.equal(result, 137);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
