import { test } from "node:test";
import assert from "node:assert/strict";
import { realExec } from "./exec.ts";

test("realExec returns stdout and exit code 0", async () => {
  const r = await realExec("node", ["-e", "process.stdout.write('hi')"]);
  assert.deepEqual(r, { code: 0, stdout: "hi", stderr: "" });
});

test("realExec returns a non-zero code instead of throwing", async () => {
  const r = await realExec("node", ["-e", "process.stderr.write('bad');process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "bad");
});

test("realExec returns code 127 when the binary is missing", async () => {
  const r = await realExec("definitely-not-a-binary-xyz", []);
  assert.equal(r.code, 127);
});

test("realExec kills the process on timeout", async () => {
  const r = await realExec("node", ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 200 });
  assert.notEqual(r.code, 0);
});
