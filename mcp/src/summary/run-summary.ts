import type { Backtest, DryRunExplain, RandomizedEntryStats } from '../platform-types';
import { untrusted } from '../output/untrusted';
import type { RunSummaryDocument } from './document';
import { headline, type HeadlineMetrics } from './shapes';

export type RunKind = 'DRY_RUN' | 'BACKTEST';

export interface LayerSummary {
  evaluatedBars: number;
  firedBars: number;
  openedBars: number;
  nearMissBars: number;
  /** Bars per outcome other than `OPENED` and `NO_SIGNAL` — what stopped the layer when its rule was not the reason. */
  blockedBy: Record<string, number>;
  /** `NO_SIGNAL` bars: the condition was evaluated and did not hold. */
  noSignalBars: number;
  /** The three conjuncts that most often were the single failing one on a near-miss bar. */
  topBlockers: { label: string; path: string; blockingPct: number; falsePct: number }[];
  caveats: string[];
}

/** One shape for a dry-run and a backtest. */
export interface RunSummary {
  kind: RunKind;
  ids: { backtestId?: number; dryRunId?: string; strategyId?: number | null; strategyVersion?: number | null };
  instrument: { exchange: string | null; symbol: string | null; timeframe: string | null; marketType: string | null };
  period: { from: string | null; to: string | null; bars: number | null; warmupBars: number | null };
  metrics: HeadlineMetrics;
  byExitReason: Record<string, { n: number; pnl: number | null; winRatePct: number | null; avgR: number | null }>;
  byLayer: Record<string, LayerSummary>;
  riskEvents: { count: number; byType: Record<string, number> } | null;
  inertFeatures: string[] | null;
  verification: { comparedAgainstStoredReport: boolean; matchesStoredReport: boolean; mismatches: string[] } | null;
  caveats: string[];
  /** This run's row in the active campaign's ledger; `null` outside a campaign. */
  trial: { campaignId: string; no: number } | null;
}

/** Everything the dry-run tool knew when it launched the run; the WS event itself names none of it. */
export interface DryRunLaunch {
  strategyId: number;
  exchange: string;
  marketType: string;
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
}

const NOT_BLOCKING = new Set(['OPENED', 'NO_SIGNAL']);

/**
 * From the summary document. For a persisted run pass the REST report too: the headline metrics are then copied from
 * `GET /backtests/{id}` — the stored numbers the UI shows — and the re-run only contributes what the report does not
 * store. If the re-run disagrees with the report, `verification` says so rather than either number winning silently.
 */
export function fromDocument(doc: RunSummaryDocument, backtest?: Backtest): RunSummary {
  const caveats: string[] = [];
  if (doc.verification.comparedAgainstStoredReport && !doc.verification.matchesStoredReport) {
    caveats.push('RERUN_DIFFERS_FROM_STORED_REPORT');
  }
  const byLayer: Record<string, LayerSummary> = {};
  for (const layerId of doc.layerIds) {
    const nearMiss = doc.nearMiss.find((entry) => entry.layer === layerId);
    const outcomes = doc.entryOutcomes[layerId] ?? {};
    const blockedBy = Object.fromEntries(
      Object.entries(outcomes)
        .filter(([outcome, bars]) => !NOT_BLOCKING.has(outcome) && bars > 0)
        .sort((a, b) => b[1] - a[1]),
    );
    byLayer[layerId] = {
      evaluatedBars: nearMiss?.evaluatedBars ?? 0,
      firedBars: nearMiss?.firedBars ?? 0,
      openedBars: nearMiss?.openedBars ?? outcomes.OPENED ?? 0,
      nearMissBars: nearMiss?.nearMissBars ?? 0,
      blockedBy,
      noSignalBars: outcomes.NO_SIGNAL ?? 0,
      topBlockers: [...(nearMiss?.summary ?? [])]
        .sort((a, b) => b.blockingPct - a.blockingPct)
        .slice(0, 3)
        .map((stat) => ({ label: untrusted(stat.label, 200) ?? '', path: stat.path, blockingPct: stat.blockingPct, falsePct: stat.falsePct })),
      caveats: nearMiss?.caveats ?? [],
    };
  }
  return {
    kind: backtest || doc.backtestId !== null ? 'BACKTEST' : 'DRY_RUN',
    ids: {
      ...(doc.backtestId !== null ? { backtestId: doc.backtestId } : {}),
      strategyId: doc.strategy.id,
      strategyVersion: doc.strategy.version,
    },
    instrument: {
      exchange: doc.params.exchange,
      symbol: doc.params.symbol,
      timeframe: doc.params.timeframe,
      marketType: doc.params.marketType,
    },
    period: { from: doc.params.from, to: doc.params.to, bars: doc.bars.recorded, warmupBars: doc.bars.warmup },
    metrics: headline(backtest ? (backtest.metrics as unknown as Record<string, unknown>) : doc.metrics),
    byExitReason: Object.fromEntries(doc.exits.map((exit) => [exit.bucket, { n: exit.trades, pnl: exit.pnl, winRatePct: exit.winRatePct, avgR: exit.avgR }])),
    byLayer,
    riskEvents: doc.riskEvents,
    inertFeatures: doc.runtime.inertFeatures ?? [],
    verification: {
      comparedAgainstStoredReport: doc.verification.comparedAgainstStoredReport,
      matchesStoredReport: doc.verification.matchesStoredReport,
      mismatches: doc.verification.warnings,
    },
    caveats,
    trial: null,
  };
}

export interface DryRunEventSummary extends RunSummary {
  randomizedEntry?: RandomizedEntryStats;
  explain?: { layer: string | null; from: string | null; to: string | null; explainedBars: number; truncated: boolean; bars: unknown[] };
}

/** Bars of an `explain` trace kept in the answer; the full trace is up to half a megabyte. */
export const EXPLAIN_BARS_KEPT = 30;

/**
 * From the `dry-run.finished` socket event — the async path, taken only for `explain` or `randomizedEntry`, which the
 * summary route does not compute. The event has no per-layer attribution, and that is stated rather than zero-filled.
 */
export function fromDryRunEvent(payload: Record<string, any>, launch: DryRunLaunch | undefined): DryRunEventSummary {
  const breakdown = (payload.breakdown ?? {}) as Record<string, { count: number; pct: number; avgProfit: number }>;
  const summary: DryRunEventSummary = {
    kind: 'DRY_RUN',
    ids: { dryRunId: String(payload.dryRunId), strategyId: launch?.strategyId ?? null },
    instrument: {
      exchange: launch?.exchange ?? null,
      symbol: launch?.symbol ?? null,
      timeframe: launch?.timeframe ?? null,
      marketType: (payload.marketType as string | undefined) ?? launch?.marketType ?? null,
    },
    period: { from: launch?.from ?? null, to: launch?.to ?? null, bars: null, warmupBars: null },
    metrics: headline(payload.summary as Record<string, unknown>),
    byExitReason: Object.fromEntries(
      Object.entries(breakdown)
        .filter(([, entry]) => entry && entry.count > 0)
        .map(([reason, entry]) => [reason, { n: entry.count, pnl: null, winRatePct: null, avgR: null }]),
    ),
    byLayer: {},
    riskEvents: null,
    inertFeatures: null,
    verification: null,
    caveats: ['LAYER_BREAKDOWN_UNAVAILABLE_ON_ASYNC_DRY_RUN'],
    trial: null,
  };
  if (!launch) {
    summary.caveats.push('LAUNCH_PARAMS_UNKNOWN');
  }
  if (payload.randomizedEntry) {
    summary.randomizedEntry = payload.randomizedEntry as RandomizedEntryStats;
  }
  if (payload.explain) {
    const explain = payload.explain as DryRunExplain;
    const bars = explain.bars ?? [];
    summary.explain = {
      layer: explain.layer,
      from: explain.from,
      to: explain.to,
      explainedBars: explain.explainedBars,
      truncated: explain.truncated || bars.length > EXPLAIN_BARS_KEPT,
      bars: bars.slice(-EXPLAIN_BARS_KEPT),
    };
    if (bars.length > EXPLAIN_BARS_KEPT) {
      summary.caveats.push(`EXPLAIN_TRIMMED_TO_LAST_${EXPLAIN_BARS_KEPT}_BARS`);
    }
  }
  return summary;
}
