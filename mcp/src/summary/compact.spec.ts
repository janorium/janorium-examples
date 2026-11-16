import { compare, leaderboard, monteCarlo, nearMiss, optimization, researchReport } from '../../test/fixtures/factories';
import { byteLength, TARGET_BYTES } from '../output/limit';
import { compactCompare, compactMonteCarlo, compactNearMiss, compactOptimization, compactResearchReport, compactTrades, trimArrays } from './compact';

const size = (value: unknown) => byteLength(JSON.stringify(value));

describe('compact forms stay within the 8 KB target on run-sized inputs', () => {
  it('near-miss: counts and blocking nodes, a sample of bars', () => {
    const out = compactNearMiss(nearMiss(1304));
    expect(out.barsListed).toBe(1304);
    expect(out.sampleBars).toHaveLength(10);
    expect(out.blockingNodes[0].label).toBe('«untrusted:RSI_14 < 40»');
    expect(out.sampleBars[0].blockingNodes[0].label).toBe('«untrusted:RSI_14 < 40»');
    expect(size(out)).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('monte carlo: percentiles and ruin under the REST name, no bands', () => {
    const out = compactMonteCarlo(monteCarlo());
    expect(out).not.toHaveProperty('equityBands');
    expect(out).not.toHaveProperty('ruinProbabilityPct');
    expect(out.maxDrawdownPct).toEqual({ p5: 1, p50: 11, p95: 21, mean: 11.3 });
    expect(out.probabilityOfRuinPct).toBe(0.2);
    expect(size(out)).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('compare: metrics side by side, no equity, a structural diff against the base', () => {
    const out = compactCompare(compare());
    expect(out.runs[0]).not.toHaveProperty('equity');
    expect(out.configDiffs).toEqual([
      { backtestId: 4212, against: 4211, changes: [{ path: 'entries[0].condition.all[0].right', op: 'changed', before: 40, after: 35 }], truncated: false },
    ]);
    expect(out.warnings[0].code).toBe('PERIOD_MISMATCH');
    expect(size(out)).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('optimization: diagnoses and the top of the leaderboard', () => {
    const out = compactOptimization(optimization(), leaderboard(120), 10);
    expect(out.leaderboard?.top).toHaveLength(10);
    expect(out.diagnosis).toBe('PLATEAU');
    expect(out.wfe).toBe(0.61);
    expect(size(out)).toBeLessThanOrEqual(TARGET_BYTES);
  });

  it('research: hypothesis counts always travel with the findings; admitted first', () => {
    const out = compactResearchReport(researchReport(400));
    expect(out.meta.featureHypotheses).toBe(400);
    expect(out.meta.effectiveFindings).toBe(3);
    expect(out.features.byAdmission).toEqual({ ADMITTED: 100, Q_ABOVE_THRESHOLD: 100, SPREAD_NOT_MEASURED: 100, NET_SPREAD_NOT_POSITIVE: 100 });
    expect(out.features.top.every((f) => f.admission === 'ADMITTED')).toBe(true);
    expect(out.features.top[0]).not.toHaveProperty('deciles');
    expect(size(out)).toBeLessThanOrEqual(TARGET_BYTES);
  });

  const trade = (id: number, exitReason: string, extra: Record<string, unknown> = {}) => ({
    id,
    side: 'LONG',
    entryTime: 'a',
    exitTime: 'b',
    entryPrice: 1,
    exitPrice: 2,
    quantity: 1,
    pnl: 1,
    pnlPct: 1,
    exitReason,
    fees: 0,
    ...extra,
  });

  it('trades: filters within the page', () => {
    const out = compactTrades({ content: [trade(1, 'TP'), trade(2, 'SL')] as never, page: 0, size: 50, totalElements: 2, totalPages: 1 }, { exitReason: 'SL' });
    expect(out.trades.map((t) => t.id)).toEqual([2]);
    expect(out.filteredOnPage).toBe(1);
  });

  it('trades: carry what reconciles pnl with the prices and reassembles a ladder', () => {
    const rung = trade(3, 'TP1', { quantity: 0.25, fees: 0.8, fundingPaid: -1.5, parentPositionId: 12, leverage: 5, marginUsed: 200, slippageCost: 0.1 });
    const [out] = compactTrades({ content: [rung] as never, page: 0, size: 50, totalElements: 1, totalPages: 1 }).trades;
    expect(out).toMatchObject({ id: 3, quantity: 0.25, fees: 0.8, fundingPaid: -1.5, parentPositionId: 12 });
    // Still thinned: the per-position futures fields stay on the REST row, as the tool description says.
    expect(out).not.toHaveProperty('leverage');
    expect(out).not.toHaveProperty('marginUsed');
    expect(out).not.toHaveProperty('slippageCost');
    // Absent on a spot or legacy row → explicit null, so the agent sees "not applicable" rather than a missing key.
    const [spot] = compactTrades({ content: [trade(4, 'SL')] as never, page: 0, size: 50, totalElements: 1, totalPages: 1 }).trades;
    expect(spot).toMatchObject({ fundingPaid: null, parentPositionId: null });
  });
});

describe('trimArrays', () => {
  it('cuts long arrays and says where', () => {
    const out = trimArrays({ fan: Array.from({ length: 100 }, (_, i) => i), nested: { rows: [1, 2] } }, 25) as Record<string, unknown>;
    expect(out.fan).toHaveLength(25);
    expect(out._trimmed).toEqual(['fan (100 → 25)']);
  });
});
