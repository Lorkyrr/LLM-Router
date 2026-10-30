import type { Exec } from "../exec.ts";

export type Lease = { acquire(): Promise<void>; release(): Promise<void> };

// O runner self-hosted fica desligado por padrão (RAM): sobe quando o primeiro PR precisa de CI e
// desce quando o último termina. Contagem de referências porque passos rodam em paralelo.
export function makeLease(exec: Exec, scripts: { up: string; down: string }): Lease {
  let holders = 0;
  let starting: Promise<void> | null = null;

  async function start() {
    const r = await exec(scripts.up, []);
    if (r.code !== 0) throw new Error(`runner failed to start: ${r.stderr || r.stdout}`);
  }

  return {
    async acquire() {
      holders++;
      try {
        if (holders === 1) starting = start();
        await starting;
      } catch (e) {
        holders--;
        if (holders === 0) starting = null;
        throw e;
      }
    },
    async release() {
      if (holders === 0) return;
      holders--;
      if (holders === 0) {
        starting = null;
        const r = await exec(scripts.down, []);
        if (r.code !== 0) console.error(`runner failed to stop: ${r.stderr || r.stdout}`);
      }
    },
  };
}
