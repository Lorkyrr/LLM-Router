import type { AdapterName, Adapter } from "../adapters/types.ts";
import { TIERS, type Config } from "../config.ts";
import type { Repo } from "../store/repo.ts";

// Cada ping abre uma sessão real (custa tokens): chame na partida e depois de uma falha de cota, não em intervalo curto.
export async function checkModels(cfg: Config, adapters: Record<AdapterName, Adapter>, repo: Repo): Promise<void> {
  const jobs = TIERS.flatMap((tier) =>
    cfg.tiers[tier].map(async (name, preference) => {
      const m = cfg.models[name]!;
      repo.upsertModel({ name, adapter: m.adapter, tier, preference });
      try {
        const r = await adapters[m.adapter].ping(m.id);
        repo.setAvailability(name, r);
      } catch {
        repo.setAvailability(name, { available: false, quota_state: "error" });
      }
    }),
  );
  await Promise.all(jobs);
}

export function availability(repo: Repo): Record<string, { available: boolean }> {
  return Object.fromEntries(repo.listModels().map((m) => [m.name, { available: m.available }]));
}

// upsert antes: sem a linha em `models` o UPDATE não pega e quem escolhe modelo repetiria o mesmo para sempre.
export function markExhausted(cfg: Config, repo: Repo, name: string): void {
  const m = cfg.models[name]!;
  repo.upsertModel({ name, adapter: m.adapter, tier: m.tier, preference: cfg.tiers[m.tier].indexOf(name) });
  repo.setAvailability(name, { available: false, quota_state: "exhausted" });
}

// Sem isto um modelo marcado `exhausted` nunca volta; pinga só os indisponíveis para custar pouco.
export async function recheckUnavailable(cfg: Config, adapters: Record<AdapterName, Adapter>, repo: Repo): Promise<void> {
  await Promise.all(
    repo.listModels().filter((row) => !row.available && cfg.models[row.name]).map(async ({ name }) => {
      const m = cfg.models[name]!;
      try {
        repo.setAvailability(name, await adapters[m.adapter].ping(m.id));
      } catch {
        repo.setAvailability(name, { available: false, quota_state: "error" });
      }
    }),
  );
}
