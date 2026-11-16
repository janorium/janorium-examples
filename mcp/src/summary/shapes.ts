export interface NearMissNodeStatShape {
  path: string;
  label: string;
  blockingBars: number;
  blockingPct: number;
  falseBars: number;
  falsePct: number;
}

/**
 * The metrics every run-shaped answer carries, under the REST report's own names so a number the model quotes can be
 * found on `/backtests/{id}` verbatim. Copied, never derived.
 */
export const HEADLINE_METRICS = [
  'totalReturnPct',
  'totalPnl',
  'maxDrawdownPct',
  'sharpeRatio',
  'profitFactor',
  'tradesCount',
  'winRatePct',
  'expectancy',
  'avgR',
  'sqn',
  'exposureTimePct',
  'largestWinShareOfProfitPct',
  'calmar',
  'pValue',
  // The mean trade on its own notional, net and gross, and the per-side cost that zeroes the gross one: whether an effect
  // that is there (pValue) is bigger than the fee, without a zero-cost re-run. Null on runs stored before 2026-11-03.
  'avgTradeReturnPct',
  'avgTradeGrossReturnPct',
  'breakEvenCostPct',
  'totalFees',
] as const;

export type HeadlineMetric = (typeof HEADLINE_METRICS)[number];
export type HeadlineMetrics = Record<HeadlineMetric, number | null>;

export function headline(metrics: Record<string, unknown> | null | undefined): HeadlineMetrics {
  const out = {} as HeadlineMetrics;
  for (const key of HEADLINE_METRICS) {
    const value = metrics?.[key];
    out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return out;
}
