import type { Config, Step } from "../config.ts";

export function repairFor(cfg: Config, original: Step, diagnostic: string, diff: string, repairs: number): Step & { reason: string } {
  const limits = cfg.repair.simple;
  const diffLines = diff.split("\n").filter(line => /^[+-]/.test(line) && !/^(--- |\+\+\+ )/.test(line)).length;
  // Resumos e linhas TAP podem coexistir: usar o maior número evita contar o mesmo teste duas vezes.
  const counts = [...diagnostic.matchAll(/(?:#\s*fail\s+|ℹ\s*fail\s+)(\d+)|\b(\d+)\s+(?:failed|failing)\b/gi)]
    .map(match => Number(match[1] ?? match[2]));
  const failedTests = Math.max(0, ...counts, [...diagnostic.matchAll(/^\s*(?:not ok\b|[✖×]\s)/gm)].length);
  const pattern = limits.patterns.find(p => new RegExp(p, "i").test(diagnostic));
  const simple = diffLines <= limits.max_diff_lines && failedTests <= limits.max_failed_tests && (pattern !== undefined || failedTests > 0);
  return simple
    ? { tier: "cheap", effort: repairs === 0 ? "low" : "medium", reason: `simple gate failure: ${failedTests} failed tests, ${diffLines} diff lines${pattern ? `, pattern ${pattern}` : ""}` }
    : { ...original, reason: `complex gate failure: ${failedTests} failed tests, ${diffLines} diff lines` };
}
