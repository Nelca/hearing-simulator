import type { Config } from "./config.js";

export interface UsageTotals {
  /** キャッシュを使わなかった入力 / Input tokens that did not touch the cache */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

// 2026年10月時点の公式料金（USD / 100万トークン）。実施前に公式の料金ページで確かめ直すこと
// Official list prices as of October 2026 (USD per 1M tokens). Re-check the pricing pages before the session.
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
  "gpt-6-astra": { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 10, cacheWritePerMTok: 10 },
  "gpt-6.1-sol": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 2, cacheWritePerMTok: 2 },
  "gpt-6-luna": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0.1 },
};

/** 概算金額（USD）。単価が分からないモデルでは null / Estimated cost in USD, or null when the model's price is unknown */
export function estimateCostUsd(usage: UsageTotals, config: Pick<Config, "model" | "priceOverride" | "provider">): number | null {
  if (config.provider === "mock") return 0;

  let price: Price | undefined = PRICES[config.model];
  if (config.priceOverride) {
    price = {
      inputPerMTok: config.priceOverride.inputPerMTok,
      outputPerMTok: config.priceOverride.outputPerMTok,
      cacheReadPerMTok: config.priceOverride.inputPerMTok,
      cacheWritePerMTok: config.priceOverride.inputPerMTok,
    };
  }
  if (!price) return null;

  return (
    (usage.inputTokens * price.inputPerMTok +
      usage.cacheReadTokens * price.cacheReadPerMTok +
      usage.cacheWriteTokens * price.cacheWritePerMTok +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000
  );
}
