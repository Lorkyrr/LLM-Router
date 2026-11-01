import type { Config } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import type { Repo, Step } from "../store/repo.ts";
import { decompose, planItems, type Subtask } from "../triage/decompose.ts";
import { availability } from "../catalog/check.ts";
import { selectForStep, type Selection } from "./selection.ts";

export type PlannedStep = Step & { selection: Selection | null };

export function storeItems(repo: Repo, taskId: string, items: Subtask[]): Step[] {
  const ids: string[] = [];
  return items.map((item, i) => {
    const step = repo.insertStep({
      task_id: taskId, seq: i + 1, brief: item.brief, tier: item.tier,
      phase: item.phase, effort: item.effort, reason: item.reason, role: item.role,
      depends_on: item.depends_on.map((d) => ids[d - 1]!), files: item.files,
      acceptance: item.acceptance, risk: item.risk, risk_reasons: item.risk_reasons,
    });
    ids.push(step.id);
    return step;
  });
}

export async function plan(cfg: Config, adapters: Record<AdapterName, Adapter>, repo: Repo, taskId: string, opts: { cwd: string }): Promise<PlannedStep[]> {
  const task = repo.getTask(taskId);
  if (!task) throw new Error(`planner: unknown task ${taskId}`);
  if (repo.listSteps(taskId).length) throw new Error(`planner: task ${taskId} already has steps`);
  repo.updateTask(taskId, { status: "planning" });
  try {
    const options = { ...opts, repo };
    const items = await decompose(cfg, adapters, task.request, options) ?? await planItems(cfg, adapters, task.request, options);
    const states = availability(repo);
    const steps = storeItems(repo, taskId, items).map((step) => ({ ...step, selection: selectForStep(cfg, step, states) }));
    if (steps.some((step) => !step.selection)) repo.updateTask(taskId, { status: "waiting_quota" });
    return steps;
  } catch (e) {
    if (e instanceof Error && e.message === "planner: no cheap model available") {
      repo.updateTask(taskId, { status: "waiting_quota" });
      return [];
    }
    throw e;
  }
}
