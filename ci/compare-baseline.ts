import { readFileSync } from "node:fs";

const NOT_OK = /^\s*not ok \d+ - (.+?)(?: # .*)?$/;
const ANY = /^\s*(?:not )?ok \d+ - /m;

export const failedTests = (tap: string): Set<string> =>
  new Set(tap.split("\n").flatMap((l) => NOT_OK.exec(l)?.[1] ?? []));

// O PR só é culpado pelo que quebrou em relação à base estável: falha que já existia na base não bloqueia.
export function regressions(baseTap: string, prTap: string): string[] {
  if (!ANY.test(prTap)) return ["<no test results from the PR run>"];
  const base = failedTests(baseTap);
  return [...failedTests(prTap)].filter((name) => !base.has(name));
}

if (import.meta.main) {
  const [baseFile, prFile] = process.argv.slice(2);
  if (!baseFile || !prFile) throw new Error("usage: compare-baseline <base.tap> <pr.tap>");
  const bad = regressions(readFileSync(baseFile, "utf8"), readFileSync(prFile, "utf8"));
  if (bad.length) {
    console.error(`regressions vs base:\n${bad.map((n) => `- ${n}`).join("\n")}`);
    process.exit(1);
  }
  console.log("no regressions vs base");
}
