import { z } from "zod";
import { PHASES, TIERS, type Config, type Phase } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability, markExhausted } from "../catalog/check.ts";
import { ROLES, phaseForRole, selectForRole, type Role } from "../planner/selection.ts";
import type { Repo } from "../store/repo.ts";
import type { Triage } from "./triage.ts";

export type Subtask = Triage & { role?: Role; brief: string; depends_on: number[]; files: string[]; reason: string;
  acceptance: string[]; risk: "low" | "high"; risk_reasons: string[] };
const schema = z.object({ steps: z.array(z.object({
  role: z.enum(ROLES).optional(),
  phase: z.enum(PHASES).optional(),
  tier: z.enum(TIERS).optional(),
  brief: z.string().trim().min(1),
  depends_on: z.array(z.number().int().positive()),
  files: z.array(z.string().min(1)),
  acceptance: z.array(z.string().trim().min(1)).default([]),
  risk: z.enum(["low", "high"]).default("low"),
  risk_reasons: z.array(z.string().trim().min(1)).default([]),
})).min(1).max(50) });

function classified(cfg: Config, brief: string, phase: Phase, depends_on: number[], files: string[], reason: string): Subtask {
  return { brief, phase, tier: cfg.phases[phase].tier, effort: cfg.phases[phase].effort, depends_on, files, reason, acceptance: [], risk: "low", risk_reasons: [] };
}

const verb = "(?:renome(?:ie|ia|ar)|tro(?:que|ca|car)|ajust(?:e|a|ar)|corr(?:ija|ige|igir)|atualiz(?:e|a|ar)|planej(?:e|a|ar)|desenh(?:e|a|ar)|defin(?:a|e|ir)|implement(?:e|a|ar)|cri(?:e|a|ar)|adicion(?:e|a|ar)|escrev(?:a|e|er)|revis(?:e|a|ar)|integr(?:e|a|ar)|refator(?:e|a|ar))";
const taskStart = new RegExp(`^${verb}\\b`, "i");
const connectors = new RegExp(`\\s*(?:(?:;|\\n+)\\s*(?:(?:e também|depois|em seguida|enquanto isso)[, ]+)?|[.,]\\s+(?=${verb}\\b)|\\s+e também\\s+|[, .]?\\s+depois[, ]+|[, .]?\\s+em seguida[, ]+|[, .]?\\s+enquanto isso[, ]+|\\s+e\\s+(?=${verb}\\b))\\s*`, "gi");

function phaseFor(brief: string): Phase | null {
  if (/^(planej\w*|desenh\w*)\b/i.test(brief) || /^defin\w*.*arquitetura/i.test(brief)) return "planning";
  if (/^revis\w*\s+(tudo|.*completa)\b/i.test(brief)) return "full_review";
  if (/^(integr\w*|refator\w*)\b/i.test(brief)) return "integration";
  if (/\b(implement\w*|testes?|api|concorr\w*)\b/i.test(brief)) return "implementing";
  if (/^(renome\w*|tro\w*|ajust\w*|atualiz\w*|corr\w*)\b/i.test(brief) && /\b(título|texto|valor|nome|variável|typo|readme)\b/i.test(brief)) return "simple_edit";
  return null;
}

// Arquivos compartilhados também ordenam os itens para evitar branches conflitantes.
export function fileDependencies(items: Subtask[]): Subtask[] {
  return items.map((item, i) => ({ ...item, depends_on: [...new Set([
    ...item.depends_on,
    ...items.slice(0, i).flatMap((prev, j) => prev.files.some((f) => item.files.includes(f)) ? [j + 1] : []),
  ])].sort((a, b) => a - b) }));
}

export async function planItems(cfg: Config, adapters: Record<AdapterName, Adapter>, request: string, opts: { cwd: string; repo: Repo }): Promise<Subtask[]> {
  for (let tries = 0; tries < 2;) {
    const states = availability(opts.repo);
    const name = selectForRole(cfg, "triage", states)?.model;
    if (!name) throw new Error("planner: no cheap model available");
    const model = cfg.models[name]!;
    const r = await adapters[model.adapter].run({
      model: model.id, effort: "low", cwd: opts.cwd, readOnly: true, timeoutMs: 60_000,
      prompt: `Separe as tarefas delegadas sem executá-las. Responda SOMENTE JSON:
{"steps":[{"role":"${ROLES.join("|")}","brief":"objetivo autossuficiente e critério de pronto","depends_on":[],"files":[],"acceptance":["critério verificável"],"risk":"low|high","risk_reasons":[]}]}
Cada item recebe sua própria fase; trivial/simple_edit, implementação/testes/implementing.
Use review para revisão delimitada, investigation para causa raiz complexa, specialized para visão/interface/escrita.
Só planejamento/arquitetura realmente complexos usam planning; integração complexa/integration; revisão completa/full_review.
"e também" e "enquanto isso" sugerem independência; "depois" espera os itens anteriores.
Referências explícitas ("conforme o plano", "após o item 1") e dependências de dados prevalecem sobre conectores aditivos.
acceptance: critérios verificáveis (comando, teste ou comportamento observável); ao menos um por item.
risk: "high" se mexer em autenticação, segurança, migração/schema, concorrência, publicação/merge, segredos ou contrato público; senão "low". "high" exige risk_reasons com o motivo.
depends_on: números de itens anteriores (1 é o primeiro); nunca próprio ou posterior.
Preserve contexto, restrições e caminhos do pedido em cada brief. Não invente tarefas ou arquivos.
Pedido: ${request}`,
    });
    if (!r.ok && r.quota_exhausted) { markExhausted(cfg, opts.repo, name); continue; }
    if (!r.ok) throw new Error(`planner: model call failed: ${r.error ?? "unknown error"}`);
    tries++;
    let raw: unknown;
    try { raw = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)); } catch { continue; }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.steps.some((s, i) => (!s.role && !s.phase && !s.tier) || s.depends_on.some((d) => d > i) || !s.acceptance.length || (s.risk === "high" && !s.risk_reasons.length))) continue;
    return fileDependencies(parsed.data.steps.map((s) => {
      const phase = s.role ? phaseForRole[s.role] : s.phase ?? (s.tier === "cheap" ? "simple_edit" : s.tier === "mid" ? "implementing" : "planning");
      const role = s.role ?? phase;
      const item = { ...classified(cfg, s.brief, phase, s.depends_on, s.files, `Decomposição cheap/low; papel ${role}; menor preço de entrada+saída na categoria configurada`),
        acceptance: s.acceptance, risk: s.risk, risk_reasons: s.risk_reasons };
      if (role === "triage") { item.tier = "cheap"; item.effort = "low"; }
      return { ...item, role };
    }));
  }
  throw new Error("planner: invalid plan after 2 tries");
}

export async function decompose(cfg: Config, adapters: Record<AdapterName, Adapter>, request: string, opts: { cwd: string; repo: Repo }): Promise<Subtask[] | null> {
  const normalized = request
    .replace(new RegExp(`(?:^|\\s+)\\d+[.)]\\s+(?=${verb}\\b|depois\\b|enquanto isso\\b)`, "gi"), "\n")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "");
  const parts = normalized.split(connectors).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // shortcut: texto com contexto comum ou comandos não reconhecidos usa cheap/low; ampliar gramática só com exemplos novos.
  if (request.includes("```") || parts.some((p) => !taskStart.test(p) || !phaseFor(p) || /\b(ess[ae]|iss[oa]|anterior|acima|respectiv\w*|conforme|plano|item\s+\d+)\b|após|depois de/i.test(p))) return planItems(cfg, adapters, request, opts);
  const items: Subtask[] = [];
  let offset = 0;
  for (const brief of parts) {
    const pos = normalized.indexOf(brief, offset);
    const separator = normalized.slice(offset, pos);
    const deps = /depois|em seguida/i.test(separator) ? items.map((_, i) => i + 1) : [];
    const files = brief.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|json|yaml|yml|md|sql|kt)\b/g) ?? [];
    const phase = phaseFor(brief)!;
    items.push(classified(cfg, brief, phase, deps, files, `Heurística: ${phase}; ${deps.length ? "aguarda os itens anteriores" : "item independente"}`));
    offset = pos + brief.length;
  }
  return fileDependencies(items);
}
