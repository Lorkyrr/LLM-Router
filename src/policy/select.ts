import type { Config, Phase, Tier } from "../config.ts";

// Modelo sem estado gravado conta como disponível; só desce de modelo, nunca de categoria.
export function selectModel(cfg: Config, tier: Tier, states: Record<string, { available: boolean }>, phase?: Phase): string | null {
  const preferred = phase && cfg.phases[phase].tier === tier ? cfg.phases[phase].prefer : [];
  return [...new Set([...preferred, ...cfg.tiers[tier]])].find((name) => cfg.models[name]?.enabled !== false && states[name]?.available !== false) ?? null;
}
