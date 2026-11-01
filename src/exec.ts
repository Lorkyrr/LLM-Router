import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { cwd?: string; timeoutMs?: number; input?: string };
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const MISSING_BINARY = 127;
const KILLED = 124;

// Processos iniciados pelo router recebem ROUTER_DEPTH+1; os hooks saem se ROUTER_DEPTH>=1.
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const depth = Number.parseInt(base.ROUTER_DEPTH ?? "0", 10);
  return { ...base, ROUTER_DEPTH: String((Number.isFinite(depth) && depth > 0 ? depth : 0) + 1) };
}

export const realExec: Exec = async (cmd, args, opts = {}) => {
  // Node cria socketpairs para stdio "pipe". Em sandboxes que bloqueiam a
  // identificação desses sockets, os filhos Node descartam stdout/stderr.
  // Arquivos privados preservam o contrato buffered do Exec sem relaxar isolamento.
  let dir: string | undefined;
  const fds: number[] = [];
  try {
    dir = mkdtempSync(join(tmpdir(), "llm-router-exec-"));
    const input = join(dir, "stdin");
    const output = join(dir, "stdout");
    const error = join(dir, "stderr");
    writeFileSync(input, opts.input ?? "", { mode: 0o600 });
    fds.push(openSync(input, "r"));
    fds.push(openSync(output, "w", 0o600));
    fds.push(openSync(error, "w", 0o600));
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, stdio: [fds[0]!, fds[1]!, fds[2]!], env: childEnv() });
      let spawnError: NodeJS.ErrnoException | undefined;
      let timedOut = false;
      const timer = opts.timeoutMs ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs) : undefined;
      child.once("error", (e: NodeJS.ErrnoException) => { spawnError = e; });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          resolve({
            code: timedOut ? KILLED : spawnError ? (spawnError.code === "ENOENT" ? MISSING_BINARY : 1) : (code ?? 1),
            stdout: readFileSync(output, "utf8"),
            stderr: readFileSync(error, "utf8") || spawnError?.message || "",
          });
        } catch (e) {
          resolve({ code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
        }
      });
    });
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  } finally {
    for (const fd of fds) closeSync(fd);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
};
