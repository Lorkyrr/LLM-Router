import type { Effort, Tier } from "../config.ts";

const TIER_OF: Record<Effort, Tier> = { low: "cheap", medium: "mid", high: "strong", xhigh: "strong" };

export const expectedTiers = (ok: Effort[]): Set<Tier> => new Set(ok.map((e) => TIER_OF[e]));
export const isCorrect = (predicted: Tier, ok: Effort[]): boolean => expectedTiers(ok).has(predicted);
