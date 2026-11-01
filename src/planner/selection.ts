import type { AdapterName } from "../adapters/types.ts";
import type { Config, Effort, Phase, Tier } from "../config.ts";

// Papéis executáveis de docs/agent-cooperation.md; Grok-Bot é transporte.
export const ROLES = ["triage", "simple_edit", "planning", "implementing", "investigation", "integration", "review", "full_review", "specialized"] as const;
export type Role = (typeof ROLES)[number];
export type Selection = { role: Role; adapter: AdapterName; model: string; model_id: string; tier: Tier; effort: Effort };
type States = Record<string, { available: boolean }>;
type Options = { author?: AdapterName; tier?: Tier; effort?: Effort };

export const phaseForRole: Record<Role, Phase> = {
  triage: "simple_edit", simple_edit: "simple_edit", planning: "planning",
  implementing: "implementing", investigation: "integration", integration: "integration",
  review: "implementing", full_review: "full_review", specialized: "implementing",
};

export function selectForRole(cfg: Config, role: Role, states: States = {}, opts: Options = {}): Selection | null {
  const policy = cfg.phases[phaseForRole[role]];
  const tier = opts.tier ?? (role === "triage" ? "cheap" : policy.tier);
  const effort = opts.effort ?? (role === "triage" ? "low" : policy.effort);
  const preferred = role === "triage" ? [cfg.triage.model] : policy.tier === tier ? policy.prefer : [];
  const candidates = [...new Set([...preferred, ...cfg.tiers[tier]])].filter((name) => {
    const model = cfg.models[name];
    return model && model.tier === tier && model.enabled && states[name]?.available !== false
      && ((model.adapter === "claude-code" && model.id.startsWith("claude-"))
        || (model.adapter === "codex" && model.id.startsWith("gpt-")))
      && !(role === "review" && opts.author === model.adapter);
  });
  // Referência de 1M tokens de entrada + 1M de saída, sem presumir cache ou consumo real.
  // sort estável mantém a preferência configurada nos empates de preço.
  candidates.sort((a, b) => {
    const left = cfg.models[a]!.price;
    const right = cfg.models[b]!.price;
    return (left.input + left.output) - (right.input + right.output);
  });
  const name = candidates[0];
  if (!name) return null;
  const model = cfg.models[name]!;
  return { role, model: name, model_id: model.id, adapter: model.adapter, tier, effort };
}

export function selectForStep(cfg: Config, step: { role?: Role | null; phase: Phase | null; tier: Tier; effort: Effort | null }, states: States = {}): Selection | null {
  const role = step.role ?? step.phase ?? (step.tier === "cheap" ? "simple_edit" : step.tier === "mid" ? "implementing" : "planning");
  return selectForRole(cfg, role, states, { tier: step.tier, effort: step.effort ?? undefined });
}
