import type { StepDeps } from "./run-step.ts";

const ref = "refs/heads/router/state";
const timeoutMs = 60_000;
// Serializa publicações deste processo; rejeições entre processos/máquinas ficam para o próximo run_plan.
let tail: Promise<void> = Promise.resolve();

export async function backupState(d: StepDeps): Promise<void> {
  if (d.cfg.verify.push === "never") return;
  const pending = tail.then(async () => {
    try {
      const git = async (args: string[], input?: string): Promise<string> => {
        const r = await d.exec("git", args, { cwd: d.repoDir, timeoutMs, ...(input === undefined ? {} : { input }) });
        if (r.code !== 0) throw new Error(`${args[0]}: exit ${r.code}`);
        return r.stdout.trim();
      };
      const remote = await d.exec("git", ["ls-remote", "--exit-code", "origin", ref], { cwd: d.repoDir, timeoutMs });
      if (remote.code !== 0 && remote.code !== 2) throw new Error(`ls-remote: exit ${remote.code}`);
      const parent = remote.code === 2 ? undefined : remote.stdout.split(/\s+/)[0];
      if (parent && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parent)) throw new Error("invalid remote object id");
      if (remote.code === 0 && !parent) throw new Error("missing remote object id");
      // Sem FETCH_HEAD, checkout, índice ou atualização de refs locais.
      if (parent) await git(["fetch", "--no-write-fetch-head", "origin", parent]);
      const blob = await git(["hash-object", "-w", "--stdin"], d.repo.exportHistory());
      const tree = await git(["mktree"], `100644 blob ${blob}\thistory.jsonl\n`);
      if (parent && await git(["rev-parse", `${parent}^{tree}`]) === tree) return;
      const commit = await git([
        "-c", "user.name=LLM-Router", "-c", "user.email=router@localhost", "commit-tree", tree,
        ...(parent ? ["-p", parent] : []), "-m", "backup: router history",
      ]);
      await git(["push", "origin", `${commit}:${ref}`]);
    } catch {
      // Não imprime saídas que possam conter URLs com credenciais nem texto vindo do banco.
      console.error("backup de router/state em origin falhou (tenta de novo no próximo run_plan)");
    }
  });
  tail = pending;
  await pending;
}
