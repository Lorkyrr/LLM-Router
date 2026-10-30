import { makeClaudeCode } from "./adapters/claude-code.ts";
import { makeGrokBuild } from "./adapters/grok-build.ts";
import { loadConfig } from "./config.ts";
import { realExec } from "./exec.ts";
import { runStep } from "./runner/run-step.ts";
import { openDb } from "./store/db.ts";
import { makeRepo } from "./store/repo.ts";

export type Args = { command: "run"; task: string };

export function parseArgs(argv: string[]): Args {
  const [command, flag, task, ...rest] = argv;
  if (command !== "run" || flag !== "--task" || !task || rest.length) {
    throw new Error("usage: cli run --task <id>");
  }
  return { command, task };
}

async function main(): Promise<number> {
  const { task: taskId } = parseArgs(process.argv.slice(2));
  const repo = makeRepo(openDb(process.env.ROUTER_DB ?? "router.db"));
  if (!repo.getTask(taskId)) throw new Error(`unknown task ${taskId}`);

  const deps = {
    cfg: loadConfig("config/router.yaml"),
    adapters: { "claude-code": makeClaudeCode(realExec), "grok-build": makeGrokBuild(realExec) },
    repo,
    exec: realExec,
    repoDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    base: "main",
    runner: "hosted" as const,
  };

  repo.updateTask(taskId, { status: "running" });
  // shortcut: ordem por seq, sem olhar depends_on; trocar por run-plan quando ele existir.
  for (const step of repo.listSteps(taskId).filter((s) => s.status === "pending")) {
    const out = await runStep(deps, step.id);
    console.log(`step ${step.seq}: ${out.status} (${out.attempts} attempts)`);
    if (out.status !== "done") {
      repo.updateTask(taskId, { status: out.status });
      return 1;
    }
  }
  repo.updateTask(taskId, { status: "done" });
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
