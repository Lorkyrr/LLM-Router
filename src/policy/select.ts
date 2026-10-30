import type { Config, Tier } from "../config.ts";

// Modelo sem estado gravado conta como disponível; só desce de modelo, nunca de categoria.
export function selectModel(cfg: Config, tier: Tier, states: Record<string, { available: boolean }>): string | null {
  return cfg.tiers[tier].find((name) => states[name]?.available !== false) ?? null;
}
