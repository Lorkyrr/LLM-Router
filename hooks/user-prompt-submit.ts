import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDbPath, openDb } from "../src/store/db.ts";
import { makeRepo, type Repo } from "../src/store/repo.ts";

export function handle(input: string, repo: Repo): void {
  let prompt: unknown;
  try {
    prompt = (JSON.parse(input) as { prompt?: unknown }).prompt;
  } catch {
    return;
  }
  if (typeof prompt !== "string" || prompt === "") return;
  repo.insertMessage({ direction: "in", channel: "claude", body: prompt });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Nunca bloquear nem falhar o prompt do usuário: erro vai para stderr e a saída é sempre 0.
  try {
    const dbPath = process.env.ROUTER_DB ?? defaultDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    handle(readFileSync(0, "utf8"), makeRepo(openDb(dbPath)));
  } catch (e) {
    console.error("user-prompt-submit hook:", e);
  }
  process.exit(0);
}
