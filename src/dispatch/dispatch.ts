import type { Config, Tier } from "../config.ts";
import type { Exec } from "../exec.ts";
import type { Repo, Runner } from "../store/repo.ts";

const ROUTER_LABEL = "router-ci";

export type Choice = { runner: Runner; refused: boolean };

export async function chooseRunner(exec: Exec, cfg: Config, opts: { repo: string; tier: Tier }): Promise<Choice> {
  const r = await exec("gh", ["api", `repos/${opts.repo}/actions/runners`]);
  if (r.code === 0 && hasRouterRunner(r.stdout)) return { runner: "self_hosted", refused: false };
  return { runner: "hosted", refused: !cfg.dispatch.cloud_tiers.includes(opts.tier) };
}

// O runner fica desligado até haver PR, então "offline" é o estado normal; o que importa é estar registrado.
function hasRouterRunner(stdout: string): boolean {
  let body: { runners?: Array<{ labels?: Array<{ name?: string }> }> };
  try {
    body = JSON.parse(stdout);
  } catch {
    // Resposta ilegível = não dá para provar que o runner existe; cair no hospedado é o lado seguro.
    return false;
  }
  return (body.runners ?? []).some((x) => x.labels?.some((l) => l.name === ROUTER_LABEL));
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
