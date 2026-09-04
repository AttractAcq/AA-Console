// Priced token accounting. Every job stamps what it cost so the Agent
// Overview page can show real numbers rather than an estimate.
//
// Rates are USD per million tokens, current as of 2026-09-04. If Anthropic
// repricing lands, change it here — nothing else reads rates.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  webSearches?: number;
}

interface Rates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const WEB_SEARCH_USD_PER_1K = 10;

const RATES: Record<string, Rates> = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
};

function ratesFor(model: string): Rates {
  const value = model.toLowerCase();
  if (value.includes("haiku")) return RATES.haiku!;
  if (value.includes("sonnet")) return RATES.sonnet!;
  if (value.includes("fable") || value.includes("mythos")) return RATES.fable!;
  // Unknown models price as opus — the expensive assumption, so a
  // mispriced run over-reports rather than hiding spend.
  return RATES.opus!;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rates = ratesFor(model);
  const perToken = (rate: number, tokens: number) => (rate * tokens) / 1_000_000;

  const total =
    perToken(rates.input, usage.inputTokens) +
    perToken(rates.output, usage.outputTokens) +
    perToken(rates.cacheWrite, usage.cacheWriteTokens ?? 0) +
    perToken(rates.cacheRead, usage.cacheReadTokens ?? 0) +
    ((usage.webSearches ?? 0) * WEB_SEARCH_USD_PER_1K) / 1000;

  // cost_usd is numeric(12,6) — round to match so the DB never truncates.
  return Math.round(total * 1_000_000) / 1_000_000;
}
