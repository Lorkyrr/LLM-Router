import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "needs-cluster.sh");
const K = "kube" + "ctl"; // montado para este arquivo de teste não se auto-detectar como "usa cluster"

const run = (files: Record<string, string>, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "nc-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    const r = spawnSync(script, [dir], { encoding: "utf8", env: { ...process.env, CI_CLUSTER: "", ...env } });
    return { out: r.stdout.trim(), err: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const plain = { "package.json": "{}", "src/a.test.ts": "test('x', () => {})", "deploy/up.sh": "echo hi", ".github/workflows/ci.yml": "name: ci\non: push\n" };

test("a plain project needs no cluster", () => {
  const r = run(plain);
  assert.equal(r.out, "off");
  assert.match(r.err, /no Kubernetes signals/);
});

for (const [label, files] of Object.entries({
  "k8s manifest": { "app/dep.yaml": "apiVersion: apps/v1\nkind: Deployment\n" },
  CRD: { "crd.yml": "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n" },
  "Helm chart": { "chart/Chart.yaml": "name: x\n" },
  Kustomize: { "kustomization.yaml": "resources: []\n" },
  "operator PROJECT file": { PROJECT: "domain: example.com\nlayout:\n- go/v4\n" },
  "k8s folder with yaml": { "k8s/a.yaml": "foo: bar\n" },
  "test using kubectl": { "t/x.test.ts": `exec('${K} get pods')` },
})) {
  test(`${label} needs a cluster`, () => {
    assert.equal(run({ ...plain, ...files }).out, "kind");
  });
}

test("node_modules is ignored", () => {
  assert.equal(run({ ...plain, "node_modules/p/Chart.yaml": "x: 1\n" }).out, "off");
});

test("CI_CLUSTER overrides detection both ways", () => {
  assert.equal(run(plain, { CI_CLUSTER: "kind" }).out, "kind");
  assert.equal(run({ ...plain, "Chart.yaml": "x: 1\n" }, { CI_CLUSTER: "off" }).out, "off");
});

test("invalid CI_CLUSTER fails", () => {
  const r = run(plain, { CI_CLUSTER: "maybe" });
  assert.equal(r.status, 2);
  assert.match(r.err, /invalid cluster mode/);
});

test("verify.cluster in config/router.yaml is used when CI_CLUSTER is unset", () => {
  assert.equal(run({ ...plain, "config/router.yaml": "verify: { cluster: kind }\n" }).out, "kind");
  assert.equal(run({ ...plain, "Chart.yaml": "x: 1\n", "config/router.yaml": "verify: { cluster: off }\n" }).out, "off");
  assert.equal(run({ ...plain, "config/router.yaml": "verify: { auto_merge: true }\n" }).out, "off");
});

test("the detector's own test files are not evidence of cluster use", () => {
  assert.equal(run({ ...plain, "ci/needs-cluster.test.ts": `exec('${K} get pods')` }).out, "off");
});

test("this repository does not need a cluster", () => {
  const r = spawnSync(script, [resolve(import.meta.dirname, "..")], { encoding: "utf8", env: { ...process.env, CI_CLUSTER: "" } });
  assert.equal(r.stdout.trim(), "off", r.stderr);
});
