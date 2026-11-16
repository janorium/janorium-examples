import type {
  Backtest,
  BacktestNearMiss,
  CompareResponse,
  MonteCarlo,
  Optimization,
  OptimizationLeaderboardResponse,
  ResearchReport,
} from '../../src/platform-types';
import type { RunSummaryDocument } from '../../src/summary/document';
import documentJson from './run-summary-document.json';

/*
 * Fixtures in the platform's JSON shapes (the REST API's examples, sized like real runs). The series-heavy
 * ones — equity bands, near-miss bar lists, leaderboards — are generated so the tests exercise real sizes without
 * thousand-line JSON files. An end-to-end smoke test checks the same code against the running platform.
 */

export function summaryDocument(): RunSummaryDocument {
  return structuredClone(documentJson);
}

/** The persisted report of the same run. `sharpeRatio` differs in the 4th decimal on purpose: stored numbers must win. */
export function backtest(): Backtest {
  const metrics = { ...summaryDocument().metrics, sharpeRatio: 1.1874 };
  return {
    id: 4211,
    status: 'DONE',
    params: {
      strategyId: 57,
      exchange: 'binance',
      marketType: 'futures',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: '2024-01-01T00:00:00Z',
      to: '2025-01-01T00:00:00Z',
      initialCapital: 10000,
      leverage: 3,
      marginMode: 'ISOLATED',
      applyFunding: true,
    },
    metrics: metrics as unknown as Backtest['metrics'],
    createdAt: '2026-09-14T10:00:00Z',
    startedAt: '2026-09-14T10:00:01Z',
    finishedAt: '2026-09-14T10:00:09Z',
  };
}

export function nearMiss(bars = 1304): BacktestNearMiss {
  const doc = summaryDocument().nearMiss[0];
  return {
    backtestId: 4211,
    from: '2024-01-01T00:00:00Z',
    to: '2025-01-01T00:00:00Z',
    truncated: false,
    ...doc,
    bars: Array.from({ length: bars }, (_, i) => ({
      ts: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000 * 6).toISOString(),
      falseCount: 1,
      outcome: 'NO_SIGNAL' as const,
      blockingNodes: [{ path: 'entries[0].condition.all[1]', label: 'RSI_14 < 40', left: 44.1 + (i % 7), right: 40 }],
    })),
  };
}

const dist = (base: number) => ({ p5: base - 10, p25: base - 4, p50: base, p75: base + 4, p95: base + 10, mean: base + 0.3, min: base - 20, max: base + 25 });

export function monteCarlo(): MonteCarlo {
  return {
    method: 'BOOTSTRAP',
    runs: 1000,
    seed: 7,
    tradesCount: 82,
    ruinPct: 50,
    initialCapital: 10000,
    actual: { finalEquity: 11493.71, totalReturnPct: 14.9371, maxDrawdownPct: 8.2 },
    finalEquity: dist(11400),
    totalReturnPct: dist(14),
    maxDrawdownPct: dist(11),
    probabilityOfRuinPct: 0.2,
    equityBands: Array.from({ length: 83 }, (_, step) => ({
      step,
      p5: 10000 - step,
      p25: 10000,
      p50: 10000 + step * 10,
      p75: 10000 + step * 20,
      p95: 10000 + step * 30,
    })),
    maxDrawdownHistogram: Array.from({ length: 40 }, (_, i) => ({ from: i, to: i + 1, count: 25 })),
    caveats: ['ASSUMES_INDEPENDENT_TRADES', 'TRADE_RESOLUTION_DRAWDOWN'],
  };
}

export function compare(): CompareResponse {
  const base = backtest();
  const config = {
    market: { type: 'futures', exchange: 'binance' },
    instrument: { symbol: 'BTCUSDT', timeframe: '1h' },
    entries: [{ id: 'trend_long', condition: { all: [{ op: 'LT', right: 40 }] } }],
  };
  const run = (id: number, isBase: boolean, rsi: number) => ({
    backtestId: id,
    base: isBase,
    status: 'DONE',
    params: base.params,
    finishedAt: base.finishedAt ?? null,
    metrics: base.metrics,
    equity: Array.from({ length: 500 }, (_, i) => ({ i, ts: new Date(Date.UTC(2024, 0, 1) + i * 60_000 * 1051).toISOString(), value: 100 + i / 50 })),
    config: { ...config, entries: [{ id: 'trend_long', condition: { all: [{ op: 'LT', right: rsi }] } }] },
    configSource: 'VERSION' as const,
  });
  return {
    runs: [run(4211, true, 40), run(4212, false, 35)],
    warnings: [{ code: 'PERIOD_MISMATCH', message: 'Runs cover different periods.', backtestIds: [4212] }],
  };
}

export function optimization(): Optimization {
  return {
    id: 91,
    name: 'EMA pullback — RSI × ADX',
    status: 'DONE',
    symbol: 'BTCUSDT',
    exchange: 'binance',
    marketType: 'futures',
    timeframe: '1h',
    variantsTotal: 120,
    windowsTotal: 6,
    variantRunsTotal: 1440,
    variantRunsDone: 1436,
    variantRunsFailed: 4,
    pct: 100,
    createdAt: '2026-09-14T09:00:00Z',
    startedAt: '2026-09-14T09:00:02Z',
    finishedAt: '2026-09-14T09:21:40Z',
    sourceStrategyId: 57,
    sourceStrategyVersion: 4,
    initialCapital: 10000,
    leverage: 3,
    marginMode: 'ISOLATED',
    applyFunding: true,
    searchSpace: [],
    sampling: { strategy: 'GRID' } as unknown as Optimization['sampling'],
    windowSpec: { mode: 'ROLLING', trainDays: 120, testDays: 30, windows: 6 } as unknown as Optimization['windowSpec'],
    scoring: {} as Optimization['scoring'],
    errorMessage: null,
    diagnosis: 'PLATEAU',
    diagnosisDetail: { sampleSize: 20, calmarMedian: 1.2, calmarIqr: 0.2, returnSpreadRatio: 1.8 },
    paretoDiagnosis: 'NONE',
    paretoDetail: { frontSize: 7, ratioMedian: 1.3, ratioIqr: 0.6 },
    wfe: 0.61,
  };
}

export function leaderboard(items = 120): OptimizationLeaderboardResponse {
  return {
    items: Array.from({ length: items }, (_, i) => ({
      variantIdx: i,
      paramValues: { 'entries[0].condition.all[1].right': 30 + (i % 15), 'entries[0].condition.all[2].right': 15 + (i % 8) },
      robustnessScore: 1 - i / items,
      windowScoreMean: 0.8 - i / (2 * items),
      windowScoreStd: 0.2,
      complexityPenalty: 0.01,
      guardFlags: i % 9 === 0 ? ['LOW_TRADES'] : [],
      status: 'DONE',
      discardReason: null,
      isFinalist: i < 3,
      isPareto: i % 11 === 0,
      finalistBacktestId: i < 3 ? 5000 + i : null,
      finalistBacktestStatus: i < 3 ? 'DONE' : null,
      testAggregates: {
        profitFactor: 1.3,
        sharpeRatio: 1.1,
        sortinoRatio: 1.5,
        totalReturnPct: 3.2,
        maxDrawdownPct: 2.4,
        expectancy: 11.2,
        tradesCountAvg: 14,
      },
    })),
    total: items,
    discarded: 12,
    failed: 1,
    finalists: 3,
    discardedByReason: { TOO_FEW_TRADES: 12 },
  };
}

export function researchReport(features = 400): ResearchReport {
  const admissions = ['ADMITTED', 'Q_ABOVE_THRESHOLD', 'SPREAD_NOT_MEASURED', 'NET_SPREAD_NOT_POSITIVE'] as const;
  return {
    meta: {
      formatVersion: 7,
      generatedAt: '2026-09-14T08:00:00Z',
      exchange: 'binance',
      marketType: 'futures',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: '2022-01-01T00:00:00Z',
      to: '2025-01-01T00:00:00Z',
      bars: 26304,
      featureColumns: 100,
      horizons: [4, 24],
      excursionHorizon: 24,
      eventHypotheses: 2,
      featureHypotheses: features,
      sliceHypotheses: 0,
      featureClusters: 41,
      effectiveFindings: 3,
      clusteringThreshold: 0.8,
      clusteringBars: 26304,
      costBps: 10,
      expectedSelectionBias: 0.021,
      resamples: 1000,
      seed: 1,
      shortlisted: 40,
      sliceShortlisted: 0,
    } as unknown as ResearchReport['meta'],
    events: Array.from({ length: 2 }, (_, i) => ({
      label: 'RSI_14 < 25',
      horizon: [4, 24][i],
      events: 310,
      independentEvents: 190,
      conditional: null,
      baseline: null,
      edge: 0.0012,
      netEdge: -0.0008,
      meanMfe: 0.02,
      meanMae: -0.018,
      tStat: 1.9,
      pValue: 0.06,
      rotationPValue: 0.08,
      qValue: 0.11,
      split: {} as never,
      flags: ['NET_EDGE_NEGATIVE'],
    })),
    features: Array.from({ length: features }, (_, i) => ({
      feature: `FEATURE_${i}`,
      group: 'momentum',
      unit: 'ratio',
      horizon: i % 2 ? 24 : 4,
      clusterId: i % 41,
      clusterRepresentative: i < 41,
      ic: 0.06 - i / 10000,
      pairs: 26000,
      independentPairs: 1100,
      pValue: i / features,
      rotationPValue: null,
      qValue: i / features,
      monotonicity: 0.8,
      decileSpread: 0.004,
      netDecileSpread: 0.002,
      admission: admissions[i % 4],
      deciles: Array.from({ length: 10 }, (_, d) => ({ index: d, lowerBound: d, upperBound: d + 1, count: 2600, meanReturn: d / 1000, hitRatePct: 50 })),
      split: {} as never,
      flags: [],
    })),
    slices: [],
    clusters: Array.from({ length: 41 }, (_, i) => ({ id: i, size: 1 + (i % 16), representative: `FEATURE_${i}` })) as unknown as ResearchReport['clusters'],
    caveats: ['OVERLAPPING_WINDOWS', 'SINGLE_INSTRUMENT', 'IN_SAMPLE'],
    runId: 311,
  };
}
