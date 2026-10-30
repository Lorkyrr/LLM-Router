import type { Config, Step, Tier } from "../config.ts";

export function stepFor(cfg: Config, startTier: Tier, attempt: number): Step | null {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);
  if (attempt > cfg.escalation.max_attempts) return null;
  return cfg.escalation.ladder[startTier][attempt - 1] ?? null;
}
