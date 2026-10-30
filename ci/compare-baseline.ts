import { readFileSync } from "node:fs";

const NOT_OK = /^\s*not ok \d+ - (.+?)(?: # .*)?$/;
const ANY = /^\s*(?:not )?ok \d+ - /m;

export const hasResults = (tap: string): boolean => ANY.test(tap);

export const failedTests = (tap: string): Set<string> =>
  new Set(tap.split("\n").flatMap((l) => NOT_OK.exec(l)?.[1] ?? []));

// O PR só é culpado pelo que quebrou em relação à base estável: falha que já existia na base não bloqueia.
export function regressions(baseTap: string, prTap: string): string[] {
  if (!hasResults(prTap)) return ["<no test results from the PR run>"];
  const base = failedTests(baseTap);
  return [...failedTests(prTap)].filter((name) => !base.has(name));
}

if (import.meta.main) {
  const [baseFile, prFile] = process.argv.slice(2);
  if (!baseFile || !prFile) throw new Error("usage: compare-baseline <base.tap> <pr.tap>");
  const baseTap = readFileSync(baseFile, "utf8");
  // Base vazio = infraestrutura do base falhou (não é regressão do PR): sem baseline, toda falha do PR conta.
  if (!hasResults(baseTap)) console.warn("no baseline: base run produced no results; every PR failure counts");
  const bad = regressions(baseTap, readFileSync(prFile, "utf8"));
  if (bad.length) {
    console.error(`regressions vs base:\n${bad.map((n) => `- ${n}`).join("\n")}`);
    process.exit(1);
  }
  console.log("no regressions vs base");
}
