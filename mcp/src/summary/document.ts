import type { NearMissNodeStatShape } from './shapes';

/**
 * `GET /backtests/{id}/summary` and `POST /strategies/dry-run/summary` — the structured twin of the export's
 * `summary.md`. Built by the platform's engine from the same re-run and the same
 * aggregators as the ZIP, so every count here equals the bundle's.
 */
export interface RunSummaryDocument {
  formatVersion: number;
  /** `null` on a dry-run: nothing was stored. */
  backtestId: number | null;
  params: {
    exchange: string;
    marketType: string;
    symbol: string;
    timeframe: string;
    from: string;
    to: string;
    initialCapital: string | null;
    leverage: number | null;
    marginMode: string | null;
    applyFunding: boolean | null;
  };
  strategy: { id: number | null; name: string | null; version: number | null; configSource: string };
  bars: { total: number; warmup: number; recorded: number };
  layerIds: string[];
  /** The re-run's metrics — the engine's `BacktestMetrics`, same names as the REST report. */
  metrics: Record<string, unknown>;
  /** `exit_reason` buckets, worst PnL first. */
  exits: { bucket: string; trades: number; pnl: number; winRatePct: number; avgR: number | null }[];
  /** Per layer, bars per `EntryOutcome`. */
  entryOutcomes: Record<string, Record<string, number>>;
  nearMiss: {
    layer: string;
    tolerance: number;
    evaluatedBars: number;
    firedBars: number;
    openedBars: number;
    nearMissBars: number;
    conjuncts: { path: string; label: string }[];
    summary: NearMissNodeStatShape[];
    caveats: string[];
  }[];
  riskEvents: { count: number; byType: Record<string, number> };
  runtime: Record<string, unknown> & { inertFeatures: string[] };
  verification: {
    comparedAgainstStoredReport: boolean;
    matchesStoredReport: boolean;
    warnings: string[];
    storedMetrics: Record<string, unknown> | null;
  };
  /**
   * `size_factor` over the trade rows that carry one — the clamped product of a layer's `sizing.multipliers`.
   * `null` when no layer declares multipliers or none traded; `byFactor` is `null` past 20 distinct factors.
   */
  sizeFactors: { trades: number; min: number; max: number; mean: number; byFactor: Record<string, number> | null } | null;
  /**
   * The trades cut by the regime of their entry bar (TREND_CHOP, TREND_EMA200, VOL_ATR_PCT, SESSION, WEEKEND,
   * FUNDING_SIGN, FUNDING_WINDOW), with `SINGLE_REGIME_PROFIT` / `REGIME_NEGATIVE` caveats. `null` when the engine
   * could not label the run; optional because older engines omit the key.
   */
  regimes?: {
    netPnl: number | null;
    families: {
      family: string;
      dimension: string;
      buckets: {
        bucket: string;
        trades: number;
        winRatePct: number;
        profitFactor: number | null;
        expectancy: number;
        pnl: number;
        pnlSharePct: number | null;
      }[];
    }[];
    caveats: {
      code: 'SINGLE_REGIME_PROFIT' | 'REGIME_NEGATIVE';
      family: string;
      bucket: string;
      sharePct: number | null;
      tradeSharePct: number | null;
      trades: number;
      expectancy: number;
    }[];
  } | null;
}
