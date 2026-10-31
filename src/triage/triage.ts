import { z } from "zod";
import { PHASES, TIERS, type Config, type Effort, type Phase, type Tier } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability, markExhausted } from "../catalog/check.ts";
import { selectModel } from "../policy/select.ts";
import type { Repo } from "../store/repo.ts";

export type Triage = { phase: Phase; tier: Tier; effort: Effort };
export type TriageOptions = { cwd: string; repo: Repo; overrideTier?: Tier };

const MAX_TRIES = 2;
const answer = z.object({ phase: z.enum(PHASES), tier: z.enum(TIERS) });

const prompt = (cfg: Config, request: string) =>
  `Você classifica pedidos de programação. Responda SOMENTE com JSON: {"phase": "...", "tier": "..."}.
Fases e a categoria de cada uma:
${PHASES.map((p) => `- ${p} → ${cfg.phases[p].tier}`).join("\n")}
Guia:
- simple_edit (cheap): troca trivial e isolada (renomear, ajustar um valor, texto), sem afetar estrutura.
- implementing (mid): implementar uma parte que se conecta a outras, código concorrente, testes.
- planning, integration, full_review (strong): desenhar estrutura e dividir trabalho, refatorar, juntar partes, revisar tudo.
- Pergunta ou explicação sobre código, edição simples e tarefas de escritório comuns: cheap ou mid, nunca strong.
- Mensagem curta de continuação ("continue", "next", "sim", uma escolha): herda a categoria do trabalho em andamento na conversa. Investigar causa raiz e migrações em massa são strong.
- Na dúvida entre duas categorias, escolha a mais baixa: se falhar, a escalada sobe sozinha.
Pedido: ${request}`;

function parseAnswer(cfg: Config, text: string): Triage | null {
  const json = text.match(/\{[^{}]*\}/)?.[0];
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const r = answer.safeParse(raw);
  // O modelo barato erra mais na categoria que na fase; a fase manda e a categoria só confirma.
  if (!r.success || cfg.phases[r.data.phase].tier !== r.data.tier) return null;
  return { phase: r.data.phase, tier: r.data.tier, effort: cfg.phases[r.data.phase].effort };
}

export async function triage(
  cfg: Config,
  adapters: Record<AdapterName, Adapter>,
  request: string,
  opts: TriageOptions,
): Promise<Triage> {
  if (opts.overrideTier) {
    const phase = PHASES.find((p) => cfg.phases[p].tier === opts.overrideTier)!;
    return { phase, tier: opts.overrideTier, effort: cfg.phases[phase].effort };
  }
  for (let tries = 0; tries < MAX_TRIES; ) {
    // cfg.triage.model é a preferência; indisponível, cai para o próximo barato.
    const states = availability(opts.repo);
    const name = cfg.models[cfg.triage.model]?.enabled && states[cfg.triage.model]?.available !== false ? cfg.triage.model : selectModel(cfg, "cheap", states);
    if (!name) throw new Error("triage: no cheap model available");
    const model = cfg.models[name]!;
    const r = await adapters[model.adapter].run({
      model: model.id,
      effort: cfg.triage.effort,
      prompt: prompt(cfg, request),
      cwd: opts.cwd,
      readOnly: true,
      timeoutMs: 60_000,
    });
    if (!r.ok && r.quota_exhausted) {
      markExhausted(cfg, opts.repo, name);
      continue;
    }
    if (!r.ok) throw new Error(`triage: model call failed: ${r.error ?? "unknown error"}`);
    tries++;
    const parsed = parseAnswer(cfg, r.text);
    if (parsed) return parsed;
  }
  throw new Error(`triage: invalid answer after ${MAX_TRIES} tries`);
}
