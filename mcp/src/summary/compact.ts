import type {
  BacktestNearMiss,
  CompareResponse,
  MonteCarlo,
  Optimization,
  OptimizationLeaderboardResponse,
  Page,
  ResearchReport,
  Trade,
} from '../platform-types';
import { untrusted } from '../output/untrusted';
import { markDiffValues, structuralDiff } from './diff';
import { headline } from './shapes';

/*
 * Compact answers. The rule: the size of `summary.md`, never of `bars.csv`. Each
 * function below keeps the numbers a decision is made on and drops the series a chart is drawn from; none of them
 * computes a number the platform did not.
 */

/** A condition label is one comparison ("RSI_14 < 40"); past this it is not a label any more. */
export const LABEL_CHARS = 200;

function markedDiff(before: unknown, after: unknown) {
  const diff = structuralDiff(before, after, 40);
  return { ...diff, changes: markDiffValues(diff.changes) };
}

export function compactNearMiss(nearMiss: BacktestNearMiss, sampleBars = 10) {
  return {
    backtestId: nearMiss.backtestId,
    layer: nearMiss.layer,
    tolerance: nearMiss.tolerance,
    from: nearMiss.from,
    to: nearMiss.to,
    evaluatedBars: nearMiss.evaluatedBars,
    firedBars: nearMiss.firedBars,
    openedBars: nearMiss.openedBars,
    nearMissBars: nearMiss.nearMissBars,
    // Labels are rendered from the config — another user's, for a public strategy.
    conjuncts: nearMiss.conjuncts.map((c) => ({ ...c, label: untrusted(c.label, LABEL_CHARS) })),
    blockingNodes: [...nearMiss.summary].sort((a, b) => b.blockingPct - a.blockingPct).map((n) => ({ ...n, label: untrusted(n.label, LABEL_CHARS) })),
    sampleBars: nearMiss.bars
      .slice(-sampleBars)
      .map((bar) => ({ ...bar, blockingNodes: bar.blockingNodes.map((n) => ({ ...n, label: untrusted(n.label, LABEL_CHARS) })) })),
    barsListed: nearMiss.bars.length,
    truncated: nearMiss.truncated,
    caveats: nearMiss.caveats,
  };
}

/** p5/p50/p95 and the mean; p25/p75/min/max are dropped — the tool description says so (the REST API has the full shape). */
const distribution = (d: { p5: number; p50: number; p95: number; mean: number }) => ({ p5: d.p5, p50: d.p50, p95: d.p95, mean: d.mean });

export function compactMonteCarlo(mc: MonteCarlo) {
  return {
    method: mc.method,
    runs: mc.runs,
    seed: mc.seed,
    tradesCount: mc.tradesCount,
    ruinPct: mc.ruinPct,
    actual: mc.actual,
    finalEquity: distribution(mc.finalEquity),
    totalReturnPct: distribution(mc.totalReturnPct),
    maxDrawdownPct: distribution(mc.maxDrawdownPct),
    // The REST contract's name, so an agent reading the REST API finds the same field here (correctness audit, 2026-10-16).
    probabilityOfRuinPct: mc.probabilityOfRuinPct,
    caveats: mc.caveats,
  };
}

export function compactCompare(response: CompareResponse) {
  const base = response.runs.find((run) => run.base) ?? response.runs[0];
  return {
    runs: response.runs.map((run) => ({
      backtestId: run.backtestId,
      base: run.base,
      status: run.status,
      instrument: { symbol: run.params.symbol, timeframe: run.params.timeframe, marketType: run.params.marketType },
      period: { from: run.params.from, to: run.params.to },
      initialCapital: run.params.initialCapital,
      metrics: run.metrics ? headline(run.metrics as unknown as Record<string, unknown>) : null,
      configSource: run.configSource,
    })),
    configDiffs: response.runs
      .filter((run) => run !== base)
      .map((run) => ({
        backtestId: run.backtestId,
        against: base?.backtestId ?? null,
        ...(base?.config == null || run.config == null ? { unavailable: true, changes: [], truncated: false } : markedDiff(base.config, run.config)),
      })),
    warnings: response.warnings.map((w) => ({ ...w, message: untrusted(w.message) })),
  };
}

export function compactOptimization(optimization: Optimization, leaderboard: OptimizationLeaderboardResponse | null, top: number) {
  return {
    runId: optimization.id,
    name: untrusted(optimization.name, 200),
    status: optimization.status,
    pct: optimization.pct,
    instrument: { exchange: optimization.exchange, symbol: optimization.symbol, timeframe: optimization.timeframe, marketType: optimization.marketType },
    source: { strategyId: optimization.sourceStrategyId, strategyVersion: optimization.sourceStrategyVersion },
    variantRuns: { total: optimization.variantRunsTotal, done: optimization.variantRunsDone, failed: optimization.variantRunsFailed },
    variantsTotal: optimization.variantsTotal,
    windowSpec: optimization.windowSpec,
    diagnosis: optimization.diagnosis,
    diagnosisDetail: optimization.diagnosisDetail,
    paretoDiagnosis: optimization.paretoDiagnosis,
    paretoDetail: optimization.paretoDetail,
    wfe: optimization.wfe,
    errorMessage: untrusted(optimization.errorMessage),
    leaderboard: leaderboard
      ? {
          total: leaderboard.total,
          discarded: leaderboard.discarded,
          failed: leaderboard.failed,
          finalists: leaderboard.finalists,
          discardedByReason: leaderboard.discardedByReason,
          top: leaderboard.items.slice(0, top).map((item) => ({
            variantIdx: item.variantIdx,
            paramValues: item.paramValues,
            robustnessScore: item.robustnessScore,
            windowScoreMean: item.windowScoreMean,
            windowScoreStd: item.windowScoreStd,
            complexityPenalty: item.complexityPenalty,
            guardFlags: item.guardFlags,
            status: item.status,
            isFinalist: item.isFinalist,
            isPareto: item.isPareto,
            finalistBacktestId: item.finalistBacktestId,
            test: item.testAggregates,
          })),
        }
      : null,
  };
}

const byQ = (a: { qValue: number }, b: { qValue: number }) => a.qValue - b.qValue;

/** `ScanSummary`. The hypothesis counts travel with every finding list, by contract. */
export function compactResearchReport(report: ResearchReport, top = 10) {
  const meta = report.meta;
  const admission: Record<string, number> = {};
  for (const finding of report.features) {
    const key = finding.admission ?? 'NOT_GATED';
    admission[key] = (admission[key] ?? 0) + 1;
  }
  const admittedFirst = [...report.features].sort((a, b) => Number(b.admission === 'ADMITTED') - Number(a.admission === 'ADMITTED') || byQ(a, b));
  return {
    runId: report.runId ?? null,
    meta: {
      exchange: meta.exchange,
      marketType: meta.marketType,
      symbol: meta.symbol,
      timeframe: meta.timeframe,
      from: meta.from,
      to: meta.to,
      bars: meta.bars,
      featureColumns: meta.featureColumns,
      horizons: meta.horizons,
      eventHypotheses: meta.eventHypotheses,
      featureHypotheses: meta.featureHypotheses,
      sliceHypotheses: meta.sliceHypotheses,
      pairHypotheses: meta.pairHypotheses ?? null,
      featureClusters: meta.featureClusters,
      effectiveFindings: meta.effectiveFindings,
      costBps: meta.costBps,
      expectedSelectionBias: meta.expectedSelectionBias ?? null,
    },
    features: {
      total: report.features.length,
      byAdmission: admission,
      top: admittedFirst.slice(0, top).map((f) => ({
        feature: f.feature,
        horizon: f.horizon,
        clusterId: f.clusterId,
        clusterRepresentative: f.clusterRepresentative,
        ic: f.ic,
        qValue: f.qValue,
        monotonicity: f.monotonicity,
        decileSpread: f.decileSpread,
        netDecileSpread: f.netDecileSpread,
        admission: f.admission ?? null,
        flags: f.flags,
        ...(f.holdout ? { holdout: f.holdout } : {}),
      })),
    },
    events: report.events.slice(0, top).map((e) => ({
      label: e.label,
      horizon: e.horizon,
      events: e.events,
      independentEvents: e.independentEvents,
      edge: e.edge,
      netEdge: e.netEdge,
      qValue: e.qValue,
      flags: e.flags,
    })),
    slices: {
      total: report.slices.length,
      top: [...report.slices]
        .sort(byQ)
        .slice(0, top)
        .map((s) => ({
          slice: s.slice,
          feature: s.feature,
          horizon: s.horizon,
          ic: s.ic,
          qValue: s.qValue,
          netDecileSpread: s.netDecileSpread,
          flags: s.flags,
        })),
    },
    clusters: {
      total: (report.clusters ?? []).length,
      largest: [...(report.clusters ?? [])]
        .sort((a, b) => b.size - a.size)
        .slice(0, top)
        .map((c) => ({ id: c.id, size: c.size, representative: c.representative })),
    },
    caveats: report.caveats,
  };
}

export interface TradeFilter {
  exitReason?: string;
  side?: 'LONG' | 'SHORT';
  entryLayerId?: string;
}

export function compactTrades(page: Page<Trade>, filter: TradeFilter = {}) {
  const trades = page.content.filter(
    (t) =>
      (!filter.exitReason || t.exitReason === filter.exitReason) &&
      (!filter.side || t.side === filter.side) &&
      (!filter.entryLayerId || t.entryLayerId === filter.entryLayerId),
  );
  return {
    page: page.page,
    size: page.size,
    totalElements: page.totalElements,
    totalPages: page.totalPages,
    filteredOnPage: filter.exitReason || filter.side || filter.entryLayerId ? trades.length : undefined,
    // Enough to reconcile pnl with the prices (quantity, fees, funding) and to reassemble a ladder's slices into one
    // position (parentPositionId); leverage/marginUsed/liquidationPrice/slippageCost/feeKind/sizeFactor/riskAmount stay
    // on the REST row — the tool description lists them (correctness audit, 2026-10-16).
    trades: trades.map((t) => ({
      id: t.id,
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      fees: t.fees,
      fundingPaid: t.fundingPaid ?? null,
      exitReason: t.exitReason,
      rMultiple: t.rMultiple ?? null,
      maePct: t.maePct ?? null,
      mfePct: t.mfePct ?? null,
      barsHeld: t.barsHeld ?? null,
      entryLayerId: t.entryLayerId ?? null,
      parentPositionId: t.parentPositionId ?? null,
    })),
  };
}

/**
 * For answers with no hand-written compact form (the analog response, a finding draft): arrays longer than `maxArray`
 * keep their head, and each cut is listed in `_trimmed` so the reader knows the series was longer.
 */
export function trimArrays(value: unknown, maxArray = 25): unknown {
  const trimmed: string[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      if (node.length > maxArray) {
        trimmed.push(`${path || '$'} (${node.length} → ${maxArray})`);
      }
      return node.slice(0, maxArray).map((item, i) => walk(item, `${path}[${i}]`));
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child, path ? `${path}.${key}` : key)]));
    }
    return node;
  };
  const result = walk(value, '');
  if (trimmed.length > 0 && result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, _trimmed: trimmed };
  }
  return result;
}
