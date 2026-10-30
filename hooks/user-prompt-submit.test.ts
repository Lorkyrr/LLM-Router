import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { makeRepo } from "../src/store/repo.ts";
import { handle } from "./user-prompt-submit.ts";

test("handle: stores the prompt as an incoming claude message", () => {
  const repo = makeRepo(openDb());
  handle(JSON.stringify({ prompt: "refatora isso", session_id: "s1" }), repo);
  const [m] = repo.listUndelivered();
  assert.equal(m?.body, "refatora isso");
  assert.equal(m?.direction, "in");
  assert.equal(m?.channel, "claude");
});

test("handle: ignores invalid JSON and missing prompt without throwing", () => {
  const repo = makeRepo(openDb());
  handle("not json", repo);
  handle(JSON.stringify({ session_id: "s1" }), repo);
  assert.equal(repo.listUndelivered().length, 0);
});
