import type { Exec, ExecOptions, ExecResult } from "../../src/exec.ts";

export type Call = { cmd: string; args: string[]; opts?: ExecOptions };
type Rule = {
  when: (call: Call) => boolean;
  reply: ExecResult | ((call: Call) => ExecResult | Promise<ExecResult>);
};

export type FakeExec = Exec & { calls: Call[] };

export function fakeExec(rules: Rule[]): FakeExec {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], opts?: ExecOptions) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const rule = rules.find((r) => r.when(call));
    if (!rule) throw new Error(`fakeExec: no rule for ${cmd} ${args.join(" ")}`);
    return typeof rule.reply === "function" ? rule.reply(call) : rule.reply;
  }) as FakeExec;
  exec.calls = calls;
  return exec;
}

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "", code = 1): ExecResult => ({ code, stdout: "", stderr });
