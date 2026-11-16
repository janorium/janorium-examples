import { backtest, summaryDocument } from '../../test/fixtures/factories';
import dryRunFinished from '../../test/fixtures/dry-run-finished.json';
import { byteLength, TARGET_BYTES } from '../output/limit';
import { EXPLAIN_BARS_KEPT, fromDocument, fromDryRunEvent } from './run-summary';
import { HEADLINE_METRICS } from './shapes';

describe('fromDocument', () => {
  it('copies the headline metrics from the stored report, field for field, when one is given', () => {
    const report = backtest();
    const summary = fromDocument(summaryDocument(), report);

    for (const key of HEADLINE_METRICS) {
      expect(summary.metrics[key]).toBe((report.metrics as unknown as Record<string, unknown>)[key] ?? null);
    }
    // The fixture's re-run Sharpe differs from the stored one — the stored one wins.
    expect(summary.metrics.sharpeRatio).toBe(1.1874);
    // Beside the significance: the mean trade on notional, and the per-side cost that would erase the gross one.
    expect(summary.metrics).toMatchObject({ avgTradeReturnPct: 0.0731, avgTradeGrossReturnPct: 0.1312, breakEvenCostPct: 0.0656 });
    expect(summary.kind).toBe('BACKTEST');
    expect(summary.ids).toEqual({ backtestId: 4211, strategyId: 57, strategyVersion: 4 });
  });

  it('uses the re-run metrics for a dry-run document', () => {
    const doc = { ...summaryDocument(), backtestId: null };
    const summary = fromDocument(doc);
    expect(summary.kind).toBe('DRY_RUN');
    expect(summary.metrics.sharpeRatio).toBe(1.1873);
    expect(summary.ids.backtestId).toBeUndefined();
  });

  it('attributes per layer: blockedBy excludes OPENED and NO_SIGNAL, top blockers sorted by blockingPct', () => {
    const layer = fromDocument(summaryDocument()).byLayer.trend_long;
    expect(layer).toMatchObject({ evaluatedBars: 7882, firedBars: 172, openedBars: 48, nearMissBars: 1304, noSignalBars: 7710 });
    expect(Object.keys(layer.blockedBy)).toEqual(['GLOBAL_CAP', 'RISK_GUARD_BLOCKED']);
    expect(layer.topBlockers.map((b) => b.label)).toEqual(['«untrusted:RSI_14 < 40»', '«untrusted:ADX_14 > 20»', '«untrusted:CLOSE > EMA_200»']);
    expect(fromDocument(summaryDocument()).byLayer.trend_short.caveats).toEqual(['ROOT_NOT_CONJUNCTIVE']);
  });

  it('keeps exits, risk events, inert features and verification', () => {
    const summary = fromDocument(summaryDocument());
    expect(summary.byExitReason.TP).toEqual({ n: 29, pnl: 3620.91, winRatePct: 100, avgR: 1.94 });
    expect(summary.riskEvents).toEqual({ count: 3, byType: { DAILY_LOSS_LIMIT: 3 } });
    expect(summary.inertFeatures).toEqual([]);
    expect(summary.verification).toEqual({ comparedAgainstStoredReport: true, matchesStoredReport: true, mismatches: [] });
    expect(summary.trial).toBeNull();
  });

  it('flags a re-run that no longer reproduces the stored report', () => {
    const doc = summaryDocument();
    doc.verification = { ...doc.verification, matchesStoredReport: false, warnings: ['Trade count differs'] };
    const summary = fromDocument(doc);
    expect(summary.caveats).toContain('RERUN_DIFFERS_FROM_STORED_REPORT');
    expect(summary.verification?.mismatches).toEqual(['Trade count differs']);
  });

  it('fits the 8 KB target', () => {
    expect(byteLength(JSON.stringify(fromDocument(summaryDocument(), backtest())))).toBeLessThanOrEqual(TARGET_BYTES);
  });
});

describe('fromDryRunEvent', () => {
  const launch = {
    strategyId: 57,
    exchange: 'binance',
    marketType: 'futures',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    from: '2024-01-01T00:00:00Z',
    to: '2025-01-01T00:00:00Z',
  };

  it('maps the event and says what it cannot know', () => {
    const summary = fromDryRunEvent(dryRunFinished, launch);
    expect(summary.kind).toBe('DRY_RUN');
    expect(summary.ids.dryRunId).toBe(dryRunFinished.dryRunId);
    expect(summary.metrics.totalReturnPct).toBe(11.204);
    expect(summary.metrics.avgR).toBeNull();
    // An event from an engine older than the per-trade returns simply lacks them: null, not zero.
    expect(summary.metrics.breakEvenCostPct).toBeNull();
    expect(Object.keys(summary.byExitReason)).toEqual(['TAKE_PROFIT', 'STOP_LOSS', 'SIGNAL']);
    expect(summary.byLayer).toEqual({});
    expect(summary.caveats).toContain('LAYER_BREAKDOWN_UNAVAILABLE_ON_ASYNC_DRY_RUN');
    expect(summary.randomizedEntry?.percentileRank).toBe(84);
    expect(summary.instrument.symbol).toBe('BTCUSDT');
  });

  it('keeps only the tail of an explain trace', () => {
    const bars = Array.from({ length: 120 }, (_, i) => ({ ts: String(i), layers: [] }));
    const summary = fromDryRunEvent(
      { ...dryRunFinished, explain: { layer: 'trend_long', from: null, to: null, explainedBars: 120, truncated: false, bars } },
      launch,
    );
    expect(summary.explain?.bars).toHaveLength(EXPLAIN_BARS_KEPT);
    expect(summary.explain?.truncated).toBe(true);
    expect(byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('notes a result whose launch parameters were not recorded', () => {
    expect(fromDryRunEvent(dryRunFinished, undefined).caveats).toContain('LAUNCH_PARAMS_UNKNOWN');
  });
});
