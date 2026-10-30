import type { Config, Tier } from "../config.ts";
import type { Exec } from "../exec.ts";
import type { Repo, Runner } from "../store/repo.ts";

export type Choice = { runner: Runner; refused: boolean };

export async function chooseRunner(exec: Exec, cfg: Config, opts: { repo: string; tier: Tier }): Promise<Choice> {
  const r = await exec("gh", ["api", `repos/${opts.repo}/actions/runners`]);
  if (r.code === 0 && hasOnlineRunner(r.stdout)) return { runner: "self_hosted", refused: false };
  return { runner: "hosted", refused: !cfg.dispatch.cloud_tiers.includes(opts.tier) };
}

function hasOnlineRunner(stdout: string): boolean {
  let body: { runners?: Array<{ status?: string }> };
  try {
    body = JSON.parse(stdout);
  } catch {
    // Resposta ilegível = não dá para provar runner online; cair no hospedado é o lado seguro.
    return false;
  }
  return (body.runners ?? []).some((x) => x.status === "online");
}

// Sem listagem global no repo: o chamador passa o task a varrer.
export function findOrphans(repo: Repo, cfg: Config, now: () => number, taskId: string): string[] {
  const limitMs = cfg.dispatch.heartbeat_timeout_s * 1000;
  return repo
    .listSteps(taskId)
    .filter((s) => {
      if (s.status !== "running") return false;
      const last = repo.listAttempts(s.id).at(-1);
      return !!last && last.finished_at === null && now() - Date.parse(last.started_at) > limitMs;
    })
    .map((s) => s.id);
}
