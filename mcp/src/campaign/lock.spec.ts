import { configHash, embargoBars, lockStart, maxHoldingBars, overlaps } from './lock';

describe('holdout lock arithmetic', () => {
  it('takes the longest maxHoldingBars anywhere in the config, and never less than 24 bars of embargo', () => {
    const config = { exit: { maxHoldingBars: 12 }, entries: [{ exit: { maxHoldingBars: 96 } }, { exit: { timeStop: { afterBars: 200 } } }] };
    expect(maxHoldingBars(config)).toBe(96);
    expect(maxHoldingBars({ exit: {} })).toBeNull();
    expect(embargoBars(96)).toBe(96);
    expect(embargoBars(null)).toBe(24);
    expect(embargoBars(5)).toBe(24);
  });

  it('measures the embargo in bars of the run’s own timeframe', () => {
    expect(new Date(lockStart('2024-01-01T00:00:00Z', '1h', 24)!).toISOString()).toBe('2023-12-31T00:00:00.000Z');
    expect(new Date(lockStart('2024-01-01T00:00:00Z', '4h', 24)!).toISOString()).toBe('2023-12-28T00:00:00.000Z');
    expect(lockStart('2024-01-01T00:00:00Z', 'weekly', 24)).toBeNull();
  });

  it('a period ending exactly at the lock is in-sample; one bar more is not', () => {
    const lockFrom = Date.parse('2023-12-31T00:00:00Z');
    const lockTo = Date.parse('2025-01-01T00:00:00Z');
    expect(overlaps({ from: '2022-01-01T00:00:00Z', to: '2023-12-31T00:00:00Z' }, lockFrom, lockTo)).toBe(false);
    expect(overlaps({ from: '2022-01-01T00:00:00Z', to: '2023-12-31T01:00:00Z' }, lockFrom, lockTo)).toBe(true);
    expect(overlaps({ from: '2024-06-01T00:00:00Z', to: '2024-07-01T00:00:00Z' }, lockFrom, lockTo)).toBe(true);
    expect(overlaps({ from: '2025-02-01T00:00:00Z', to: '2025-03-01T00:00:00Z' }, lockFrom, lockTo)).toBe(false);
  });

  it('hashes a config written through params exactly like its literal spelling', () => {
    const literal = { exit: { maxHoldingBars: 48, atrRef: { indicator: 'ATR', params: { period: 14 } } } };
    const viaParams = {
      params: { atrPeriod: 14, hold: 48 },
      exit: { maxHoldingBars: { $param: 'hold' }, atrRef: { indicator: 'ATR', params: { period: { $param: 'atrPeriod' } } } },
    };
    expect(configHash(viaParams)).toBe(configHash(literal));
    expect(configHash({ ...viaParams, params: { atrPeriod: 21, hold: 48 } })).not.toBe(configHash(literal));
    // The embargo must see a holding period written through a parameter, or the lock would be 24 bars too short.
    expect(maxHoldingBars(viaParams)).toBe(48);
  });

  it('hashes a config independent of key order', () => {
    expect(configHash({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(configHash({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });
});
