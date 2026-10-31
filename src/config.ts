import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const TIERS = ["cheap", "mid", "strong"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const PHASES = ["planning", "implementing", "integration", "full_review", "simple_edit"] as const;

export type Tier = (typeof TIERS)[number];
export type Effort = (typeof EFFORTS)[number];
export type Phase = (typeof PHASES)[number];

const tier = z.enum(TIERS);
const effort = z.enum(EFFORTS);
const step = z.object({ tier, effort });
const phasePolicy = step.extend({ prefer: z.array(z.string()).default([]) });
const rank = (t: Tier) => TIERS.indexOf(t);

// USD por 1M de tokens; o custo real vem do CLI, isto só serve de estimativa e da linha de base "tudo no forte".
const rate = z.number().nonnegative();
const price = z.object({ input: rate, output: rate, cache_read: rate, cache_write: rate });

const model = z.object({
  adapter: z.enum(["claude-code", "grok-build", "codex"]),
  id: z.string().min(1),
  tier,
  price,
  enabled: z.boolean().default(true),
  guidance: z.string().min(1).optional(),
  pricing: z.object({
    source: z.url(),
    checked_at: z.iso.date(),
    basis: z.literal("standard_short_context"),
  }).optional(),
});

const schema = z
  .object({
    triage: z.object({ model: z.string(), effort }),
    models: z.record(z.string(), model),
    tiers: z.object({
      cheap: z.array(z.string()).min(1),
      mid: z.array(z.string()).min(1),
      strong: z.array(z.string()).min(1),
    }),
    phases: z.object(Object.fromEntries(PHASES.map((p) => [p, phasePolicy])) as Record<Phase, typeof phasePolicy>),
    escalation: z.object({
      max_attempts: z.number().int().positive(),
      ladder: z.object({
        cheap: z.array(step).min(1),
        mid: z.array(step).min(1),
        strong: z.array(step).min(1),
      }),
    }),
    verify: z.object({ auto_merge: z.boolean(), delete_branch: z.boolean() }),
    dispatch: z.object({ cloud_tiers: z.array(tier), heartbeat_timeout_s: z.number().int().positive() }),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Map<string, Tier>();
    for (const t of TIERS) {
      for (const name of cfg.tiers[t]) {
        const m = cfg.models[name];
        if (!m) {
          ctx.addIssue({ code: "custom", message: `tiers.${t} references unknown model "${name}"` });
          continue;
        }
        if (m.tier !== t) {
          ctx.addIssue({ code: "custom", message: `model "${name}" is in tiers.${t} but declares tier "${m.tier}"` });
        }
        const prev = seen.get(name);
        if (prev) ctx.addIssue({ code: "custom", message: `model "${name}" is in two tiers (${prev}, ${t})` });
        seen.set(name, t);
      }
    }
    if (!cfg.models[cfg.triage.model]) {
      ctx.addIssue({ code: "custom", message: `triage.model "${cfg.triage.model}" is not in models` });
    }
    for (const p of PHASES) {
      const policy = cfg.phases[p];
      for (const name of policy.prefer) {
        if (!cfg.tiers[policy.tier].includes(name)) {
          ctx.addIssue({ code: "custom", message: `phases.${p}.prefer references model "${name}" outside tier ${policy.tier}` });
        }
      }
    }
    for (const t of TIERS) {
      const steps = cfg.escalation.ladder[t];
      if (steps.some((s, i) => i > 0 && rank(s.tier) < rank(steps[i - 1]!.tier))) {
        ctx.addIssue({ code: "custom", message: `escalation ladder "${t}" steps down a tier` });
      }
    }
  });

export type Config = z.infer<typeof schema>;
export type Model = z.infer<typeof model>;
export type Step = z.infer<typeof step>;

export const parseConfig = (raw: unknown): Config => schema.parse(raw);
export const loadConfig = (path: string): Config => parseConfig(parse(readFileSync(path, "utf8")));
