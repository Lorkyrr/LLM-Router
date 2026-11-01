import type { Config } from "../config.ts";
import type { Adapter, AdapterName } from "../adapters/types.ts";
import type { Repo, Step } from "../store/repo.ts";
import { decompose, planItems, type Subtask } from "../triage/decompose.ts";

export function storeItems(repo: Repo, taskId: string, items: Subtask[]): Step[] {
  const ids: string[] = [];
  return items.map((item, i) => {
    const step = repo.insertStep({
      task_id: taskId, seq: i + 1, brief: item.brief, tier: item.tier,
      phase: item.phase, effort: item.effort, reason: item.reason,
      depends_on: item.depends_on.map((d) => ids[d - 1]!), files: item.files,
    });
    ids.push(step.id);
    return step;
  });
}

export async function plan(cfg: Config, adapters: Record<AdapterName, Adapter>, repo: Repo, taskId: string, opts: { cwd: string }): Promise<Step[]> {
  const task = repo.getTask(taskId);
  if (!task) throw new Error(`planner: unknown task ${taskId}`);
  if (repo.listSteps(taskId).length) throw new Error(`planner: task ${taskId} already has steps`);
  repo.updateTask(taskId, { status: "planning" });
  try {
    const options = { ...opts, repo };
    const items = await decompose(cfg, adapters, task.request, options) ?? await planItems(cfg, adapters, task.request, options);
    return storeItems(repo, taskId, items);
  } catch (e) {
    if (e instanceof Error && e.message === "planner: no cheap model available") {
      repo.updateTask(taskId, { status: "waiting_quota" });
      return [];
    }
    throw e;
  }
}
