import type { Channel, Repo } from "../store/repo.ts";

export type Transport = (body: string) => Promise<void>;

const SUMMARY_BODY_CHARS = 80;

export async function relay(
  repo: Repo,
  transport: Transport,
  msg: { body: string; task_id?: string },
): Promise<{ channel: Channel; delivered: boolean }> {
  const m = repo.insertMessage({ direction: "out", channel: "grok_bot", ...msg });
  try {
    await transport(msg.body);
  } catch {
    // bot offline: o fluxo segue e o Claude lê a mensagem por `status`
    repo.setMessageChannel(m.id, "claude");
    return { channel: "claude", delivered: false };
  }
  repo.markDelivered(m.id);
  return { channel: "grok_bot", delivered: true };
}

export async function flush(repo: Repo, transport: Transport): Promise<number> {
  // direction "in" são prompts do usuário gravados pelo hook; não são reenviados
  const pending = repo.listUndelivered().filter((m) => m.direction === "out");
  if (pending.length === 0) return 0;
  const lines = pending.map((m) => `- ${m.body.length > SUMMARY_BODY_CHARS ? `${m.body.slice(0, SUMMARY_BODY_CHARS)}…` : m.body}`);
  try {
    await transport(`${pending.length} mensagens pendentes:\n${lines.join("\n")}`);
  } catch {
    return 0;
  }
  for (const m of pending) repo.markDelivered(m.id);
  return pending.length;
}
