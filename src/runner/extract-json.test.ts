import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "./run-plan.ts";

test("extractJson aceita JSON puro, em cerca e com texto em volta", () => {
  assert.deepEqual(extractJson('{"approved":true,"findings":[]}'), { approved: true, findings: [] });
  assert.deepEqual(extractJson('```json\n{"approved":false,"findings":["x"]}\n```'), { approved: false, findings: ["x"] });
  assert.deepEqual(extractJson('Revisei.\n{"approved":true,"findings":["ok {a}"]}\nFim.'), { approved: true, findings: ["ok {a}"] });
  assert.throws(() => extractJson("sem json"));
});
