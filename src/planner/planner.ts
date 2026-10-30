import { z } from "zod";
import { TIERS, type Config } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import { availability, markExhausted } from "../catalog/check.ts";
import { selectModel } from "../policy/select.ts";
import type { Repo, Step } from "../store/repo.ts";

const MAX_TRIES = 2;
const planSchema = z.object({
  steps: z
    .array(
      z.object({
        tier: z.enum(TIERS),
        brief: z.string().min(1),
        depends_on: z.array(z.number().int().positive()),
        files: z.array(z.string()),
      }),
    )
    .min(1),
});
type Planned = z.infer<typeof planSchema>["steps"];

const prompt = (request: string) =>
  `Você planeja trabalho de programação. Divida o pedido em passos pequenos que um modelo executa sozinho, sem ver esta conversa.
Responda SOMENTE com JSON: {"steps":[{"tier":"cheap|mid|strong","brief":"...","depends_on":[1],"files":["caminho"]}]}
- brief: curto e autossuficiente (o que fazer, onde, critério de pronto). Sem histórico.
- tier: mid para partes que se conectam a outras; cheap só para o trivial e isolado; strong só para o que não se divide.
- depends_on: números (1 = primeiro passo) de passos anteriores que precisam estar prontos. Nunca o próprio passo nem posteriores.
- files: todos os arquivos que o passo toca.
Pedido: ${request}`;

function parsePlan(text: string): Planned | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const r = planSchema.safeParse(raw);
  if (!r.success) return null;
  const forward = r.data.steps.some((s, i) => s.depends_on.some((d) => d > i));
  return forward ? null : r.data.steps;
}

// Arquivos em comum viram dependência do passo anterior: dois branches no mesmo arquivo conflitariam no merge.
function withFileDeps(steps: Planned): number[][] {
  return steps.map((s, i) => {
    const deps = new Set(s.depends_on);
    steps.slice(0, i).forEach((prev, j) => {
      if (prev.files.some((f) => s.files.includes(f))) deps.add(j + 1);
    });
    return [...deps].sort((a, b) => a - b);
  });
}

export async function plan(
  cfg: Config,
  adapters: Record<AdapterName, Adapter>,
  repo: Repo,
  taskId: string,
  opts: { cwd: string },
): Promise<Step[]> {
  const task = repo.getTask(taskId);
  if (!task) throw new Error(`planner: unknown task ${taskId}`);
  if (repo.listSteps(taskId).length > 0) throw new Error(`planner: task ${taskId} already has steps`);
  repo.updateTask(taskId, { status: "planning" });

  for (let tries = 0; tries < MAX_TRIES; ) {
    const name = selectModel(cfg, "strong", availability(repo));
    if (!name) {
      repo.updateTask(taskId, { status: "waiting_quota" });
      return [];
    }
    const model = cfg.models[name]!;
    const r = await adapters[model.adapter].run({
      model: model.id,
      effort: cfg.phases.planning.effort,
      prompt: prompt(task.request),
      cwd: opts.cwd,
    });
    if (!r.ok && r.quota_exhausted) {
      markExhausted(cfg, repo, name);
      continue;
    }
    if (!r.ok) throw new Error(`planner: model call failed: ${r.error ?? "unknown error"}`);
    tries++;
    const planned = parsePlan(r.text);
    if (!planned) continue;
    const deps = withFileDeps(planned);
    const ids: string[] = [];
    return planned.map((s, idx) => {
      const step = repo.insertStep({
        task_id: taskId,
        seq: idx + 1,
        brief: s.brief,
        tier: s.tier,
        depends_on: deps[idx]!.map((d) => ids[d - 1]!),
        files: s.files,
      });
      ids.push(step.id);
      return step;
    });
  }
  throw new Error(`planner: invalid plan after ${MAX_TRIES} tries`);
}
