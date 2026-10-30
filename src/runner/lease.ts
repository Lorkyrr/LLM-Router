import type { Exec } from "../exec.ts";

export type Lease = { acquire(): Promise<void>; release(): Promise<void> };

// O runner self-hosted fica desligado por padrão (RAM): sobe quando o primeiro PR precisa de CI e
// desce quando o último termina. Contagem de referências porque passos rodam em paralelo.
// up e down passam pela mesma cadeia: um acquire durante um down em andamento espera o down e só então sobe.
export function makeLease(exec: Exec, scripts: { up: string; down: string; args?: string[] }): Lease {
  const args = scripts.args ?? [];
  let holders = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };

  async function start() {
    const r = await exec(scripts.up, args);
    if (r.code !== 0) throw new Error(`runner failed to start: ${r.stderr || r.stdout}`);
  }

  async function stop() {
    const r = await exec(scripts.down, args);
    if (r.code !== 0) console.error(`runner failed to stop: ${r.stderr || r.stdout}`);
  }

  return {
    async acquire() {
      if (++holders === 1) ready = enqueue(start);
      try {
        await ready;
      } catch (e) {
        holders--;
        throw e;
      }
    },
    async release() {
      if (holders === 0) return;
      if (--holders === 0) await enqueue(stop);
    },
  };
}
