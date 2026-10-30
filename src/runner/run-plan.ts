import type { Step } from "../store/repo.ts";
import { runStep, type StepDeps } from "./run-step.ts";

export type PlanOutcome = { done: number[]; failed: number[]; blocked: number[]; waiting_quota: number[] };
type Result = "done" | "failed" | "waiting_quota" | "blocked";

export async function runPlan(d: StepDeps, taskId: string): Promise<PlanOutcome> {
  const steps = d.repo.listSteps(taskId);
  const byId = new Map(steps.map((s) => [s.id, s]));

  // Ponto fixo: só é agendável quem tem todas as dependências agendáveis. Ciclo ou id inexistente nunca entra,
  // então o grafo de promessas abaixo é acíclico e não trava esperando a si mesmo.
  const schedulable = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of steps) {
      if (!schedulable.has(s.id) && s.depends_on.every((id) => schedulable.has(id))) {
        schedulable.add(s.id);
        grew = true;
      }
    }
  }

  const results = new Map<string, Promise<Result>>();
  const start = (s: Step): Promise<Result> => {
    let p = results.get(s.id);
    if (!p) {
      p = (async (): Promise<Result> => {
        if (!schedulable.has(s.id)) return "blocked";
        const deps = await Promise.all(s.depends_on.map((id) => start(byId.get(id) as Step)));
        if (deps.some((r) => r !== "done")) return "blocked";
        return (await runStep(d, s.id)).status;
      })();
      results.set(s.id, p);
    }
    return p;
  };

  d.repo.updateTask(taskId, { status: "running" });
  let settled: Result[];
  try {
    settled = await Promise.all(steps.map(start));
  } catch (e) {
    d.repo.updateTask(taskId, { status: "failed" });
    throw e;
  }

  const seqs = (r: Result) => steps.filter((_, i) => settled[i] === r).map((s) => s.seq);
  const out: PlanOutcome = { done: seqs("done"), failed: seqs("failed"), blocked: seqs("blocked"), waiting_quota: seqs("waiting_quota") };
  // Bloqueado sem passo em espera de cota só acontece por ciclo/dependência inválida: é falha do plano.
  const status = out.failed.length ? "failed" : out.waiting_quota.length ? "waiting_quota" : out.blocked.length ? "failed" : "done";
  d.repo.updateTask(taskId, { status });
  return out;
}
