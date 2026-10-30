import type { Config, Model } from "../config.ts";

export type Usage = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

const PER_MILLION = 1_000_000;

export function estimateCost(price: Model["price"], u: Usage): number {
  return (
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      u.cache_read_tokens * price.cache_read +
      u.cache_write_tokens * price.cache_write) /
    PER_MILLION
  );
}

// "Quanto custaria se tudo tivesse rodado no modelo forte preferido"
export function strongBaseline(cfg: Config, u: Usage): number {
  const name = cfg.tiers.strong[0] as string;
  return estimateCost((cfg.models[name] as Model).price, u);
}
