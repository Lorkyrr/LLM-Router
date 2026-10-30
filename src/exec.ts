import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { cwd?: string; timeoutMs?: number; input?: string };
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const MISSING_BINARY = 127;
const KILLED = 124;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: e.code === "ENOENT" ? MISSING_BINARY : 1, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? KILLED : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
