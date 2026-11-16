import fixture from '../../test/fixtures/deflated-sharpe-fixture.json';
import { campaignDeflatedSharpe, deflatedSharpe, expectedMaximum, inverseNormalCdf, normalCdf, probabilisticSharpe } from './deflated-sharpe';

/*
 * The campaign's DSR equals the platform's own implementation to 1e-9. The same JSON is asserted by the platform's test
 * suite, so neither side can move without the other's build failing.
 */
const close = (actual: number | null, expected: number | null) => {
  if (expected === null) {
    expect(actual).toBeNull();
  } else {
    expect(actual).not.toBeNull();
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(fixture.tolerance);
  }
};

describe('Deflated Sharpe — parity with the platform implementation', () => {
  it.each(fixture.deflatedSharpe)('of($sharpe, $dailyReturns, $skew, $excessKurtosis, $trials)', (c) => {
    close(deflatedSharpe(c.sharpe, c.dailyReturns, c.skew, c.excessKurtosis, c.trials), c.expected);
  });

  it('expectedMaximum, the normal tails and probabilisticSharpe', () => {
    fixture.expectedMaximum.forEach((c) => close(expectedMaximum(c.trials, c.variance), c.expected));
    fixture.inverseNormalCdf.forEach((c) => close(inverseNormalCdf(c.p), c.expected));
    fixture.normalCdf.forEach((c) => close(normalCdf(c.x), c.expected));
    fixture.probabilisticSharpe.forEach((c) => close(probabilisticSharpe(c.sharpe, c.benchmark, c.n, c.skew, c.excessKurtosis), c.expected));
  });

  it('keeps the published pins of the Java test', () => {
    expect(Math.abs(normalCdf(1.0) - 0.8413447461)).toBeLessThan(1e-9);
    expect(Math.abs(inverseNormalCdf(0.975) - 1.959963985)).toBeLessThan(1e-9);
    expect(deflatedSharpe(1.4, 365, 0, 0, 524)!).toBeLessThan(deflatedSharpe(1.4, 365, 0, 0, 2)!);
    expect(deflatedSharpe(1.4, 900, 0, 0, 524)!).toBeGreaterThan(deflatedSharpe(1.4, 90, 0, 0, 524)!);
  });
});

describe('campaignDeflatedSharpe', () => {
  const base = { annualisedSharpe: 2.1, dailyReturns: 700, skew: -0.2, excessKurtosis: 1.5, trials: 30 };

  it('is the Java formula when the ledger spread is narrower than the null', () => {
    const verdict = campaignDeflatedSharpe({ ...base, trialSharpes: [1.0, 1.01, 1.02] });
    expect(verdict.varianceSource).toBe('NULL_MODEL');
    close(verdict.dsr, deflatedSharpe(2.1, 700, -0.2, 1.5, 30));
  });

  it('raises the bar when the attempts were spread wider than the null', () => {
    const wide = campaignDeflatedSharpe({ ...base, trialSharpes: [-3, -1, 0, 1, 3, 5] });
    expect(wide.varianceSource).toBe('LEDGER');
    expect(wide.dsr!).toBeLessThan(deflatedSharpe(2.1, 700, -0.2, 1.5, 30)!);
    expect(wide.benchmarkSharpeAnnualised!).toBeGreaterThan(campaignDeflatedSharpe({ ...base, trialSharpes: [] }).benchmarkSharpeAnnualised!);
  });

  it('answers nothing, not zero, without its inputs or with one trial', () => {
    expect(campaignDeflatedSharpe({ ...base, dailyReturns: null, trialSharpes: [] }).dsr).toBeNull();
    expect(campaignDeflatedSharpe({ ...base, trials: 1, trialSharpes: [] }).dsr).toBeNull();
  });
});
