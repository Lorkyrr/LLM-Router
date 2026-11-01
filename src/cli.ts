import { makeAdapters } from "./adapters/registry.ts";
import { loadConfig } from "./config.ts";
import { realExec } from "./exec.ts";
import { runPlan } from "./runner/run-plan.ts";
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
    adapters: makeAdapters(realExec),
    repo,
    exec: realExec,
    repoDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    base: "main",
    runner: "hosted" as const,
  };

  const out = await runPlan(deps, taskId);
  console.log(JSON.stringify(out));
  return out.failed.length + out.blocked.length + out.waiting_quota.length + (out.awaiting_review?.length ?? 0) ? 1 : 0 // pr_open é sucesso: o release é outro sinal;
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
