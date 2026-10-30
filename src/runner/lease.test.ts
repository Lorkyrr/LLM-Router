import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExec, ok, fail } from "../../test/fixtures/fake-exec.ts";
import { makeLease } from "./lease.ts";

const names = (e: { calls: Array<{ cmd: string }> }) => e.calls.map((c) => c.cmd);

test("first acquire starts the runner, last release stops it", async () => {
  const exec = fakeExec([{ when: () => true, reply: ok() }]);
  const lease = makeLease(exec, { up: "ci/runner-up.sh", down: "ci/runner-down.sh" });
  await lease.acquire();
  await lease.acquire();
  assert.deepEqual(names(exec), ["ci/runner-up.sh"]);
  await lease.release();
  assert.deepEqual(names(exec), ["ci/runner-up.sh"]);
  await lease.release();
  assert.deepEqual(names(exec), ["ci/runner-up.sh", "ci/runner-down.sh"]);
});

test("concurrent acquires start the runner once", async () => {
  const exec = fakeExec([{ when: () => true, reply: async () => (await new Promise((r) => setTimeout(r, 10)), ok()) }]);
  const lease = makeLease(exec, { up: "up", down: "down" });
  await Promise.all([lease.acquire(), lease.acquire(), lease.acquire()]);
  assert.equal(exec.calls.length, 1);
});

test("a failed start throws and leaves nothing held", async () => {
  const exec = fakeExec([{ when: (c) => c.cmd === "up", reply: fail("no systemd") }, { when: () => true, reply: ok() }]);
  const lease = makeLease(exec, { up: "up", down: "down" });
  await assert.rejects(() => lease.acquire(), /runner failed to start: no systemd/);
  await lease.release();
  assert.equal(exec.calls.length, 1, "nothing to stop");
  await lease.acquire().catch(() => {});
  assert.equal(exec.calls.length, 2, "next acquire tries again");
});
