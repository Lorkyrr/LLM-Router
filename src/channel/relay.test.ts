import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../store/db.ts";
import { makeRepo } from "../store/repo.ts";
import { flush, relay } from "./relay.ts";

const ok = async () => {};
const down = async () => {
  throw new Error("bot offline");
};

test("relay: transport ok delivers via grok_bot", async () => {
  const repo = makeRepo(openDb());
  const sent: string[] = [];
  const r = await relay(repo, async (b) => void sent.push(b), { body: "feito" });
  assert.deepEqual(r, { channel: "grok_bot", delivered: true });
  assert.deepEqual(sent, ["feito"]);
  assert.equal(repo.listUndelivered().length, 0);
});

test("relay: transport failure keeps the message undelivered on the claude channel", async () => {
  const repo = makeRepo(openDb());
  const r = await relay(repo, down, { body: "feito" });
  assert.deepEqual(r, { channel: "claude", delivered: false });
  const [m] = repo.listUndelivered();
  assert.equal(m?.channel, "claude");
  assert.equal(m?.direction, "out");
});

test("flush: sends one summary and marks all delivered only if transport works", async () => {
  const repo = makeRepo(openDb());
  await relay(repo, down, { body: "a".repeat(500) });
  await relay(repo, down, { body: "segunda" });
  repo.insertMessage({ direction: "in", channel: "claude", body: "prompt do usuário" });

  assert.equal(await flush(repo, down), 0);
  assert.equal(repo.listUndelivered().length, 3);

  const sent: string[] = [];
  assert.equal(await flush(repo, async (b) => void sent.push(b)), 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /2/);
  assert.ok((sent[0] ?? "").length < 500);
  assert.deepEqual(repo.listUndelivered().map((m) => m.direction), ["in"]);
});

test("flush: nothing pending does not call the transport", async () => {
  const repo = makeRepo(openDb());
  let calls = 0;
  assert.equal(await flush(repo, async () => void calls++), 0);
  assert.equal(calls, 0);
});
