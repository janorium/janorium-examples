/**
 * The Deflated Sharpe Ratio — a line-by-line port of the platform's implementation behind research drafts, so a
 * campaign's verdict and a research draft's verdict are the same number for the same inputs.
 * `test/fixtures/deflated-sharpe-fixture.json` is asserted by this package's spec **and** by the platform's test suite;
 * the two implementations may not drift apart by more than 1e-9.
 *
 * The Java class documents the four decisions (annualised → per-observation, excess kurtosis used raw, the null's
 * variance across trials, `trials` as the correction's `m`). The campaign adds one thing on top, in
 * {@link campaignDeflatedSharpe}: unlike a research run, a campaign **has** the Sharpe of every attempt, so the published
 * formula's empirical variance is available — and it is used only when it raises the benchmark.
 */

/** Must equal `EquityStats.TRADING_DAYS_PER_YEAR`: the engine annualises daily Sharpe with √365. */
export const TRADING_DAYS_PER_YEAR = 365;
/** The Java literal carries more digits than a double holds; this is the same double. */
export const EULER_MASCHERONI = 0.5772156649015329;
export const MIN_RETURNS = 4;

export function deflatedSharpe(
  annualisedSharpe: number | null | undefined,
  dailyReturns: number | null | undefined,
  skew: number | null | undefined,
  excessKurtosis: number | null | undefined,
  trials: number | null | undefined,
): number | null {
  if (annualisedSharpe == null || dailyReturns == null || skew == null || excessKurtosis == null || trials == null) {
    return null;
  }
  const n = Math.trunc(dailyReturns);
  if (n < MIN_RETURNS || trials < 2 || !Number.isFinite(annualisedSharpe) || !Number.isFinite(skew) || !Number.isFinite(excessKurtosis)) {
    return null;
  }
  const sharpe = annualisedSharpe / Math.sqrt(TRADING_DAYS_PER_YEAR);
  const benchmark = expectedMaximum(Math.trunc(trials), 1.0 / (n - 1));
  return probabilisticSharpe(sharpe, benchmark, n, skew, excessKurtosis);
}

export function expectedMaximum(trials: number, varianceAcrossTrials: number): number {
  const first = inverseNormalCdf(1.0 - 1.0 / trials);
  const second = inverseNormalCdf(1.0 - 1.0 / (trials * Math.E));
  return Math.sqrt(varianceAcrossTrials) * ((1 - EULER_MASCHERONI) * first + EULER_MASCHERONI * second);
}

export function probabilisticSharpe(sharpe: number, benchmark: number, n: number, skew: number, excessKurtosis: number): number | null {
  const kurtosis = excessKurtosis + 3.0;
  const variance = 1.0 - skew * sharpe + ((kurtosis - 1.0) / 4.0) * sharpe * sharpe;
  if (!(variance > 0)) {
    return null;
  }
  const z = ((sharpe - benchmark) * Math.sqrt(n - 1.0)) / Math.sqrt(variance);
  return normalCdf(z);
}

export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.sqrt(2.0));
}

const ERFC_COEFFICIENTS = [
  -1.3026537197817094, 6.419697923564902e-1, 1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5,
  -2.0278578112534e-5, -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
  -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
];

/** Numerical Recipes' Chebyshev-fitted complementary error function — the same coefficients as the Java class. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2.0 / (2.0 + z);
  const ty = 4.0 * t - 2.0;
  let d = 0.0;
  let dd = 0.0;
  for (let j = ERFC_COEFFICIENTS.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERFC_COEFFICIENTS[j];
    dd = tmp;
  }
  const answer = t * Math.exp(-z * z + 0.5 * (ERFC_COEFFICIENTS[0] + ty * d) - dd);
  return x >= 0.0 ? answer : 2.0 - answer;
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Acklam's rational approximation with one Halley step, as in the Java class. */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`p must be in (0, 1), was ${p}`);
  }
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  const error = normalCdf(x) - p;
  const u = error * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export interface CampaignDsrInputs {
  annualisedSharpe: number | null;
  dailyReturns: number | null;
  skew: number | null;
  excessKurtosis: number | null;
  trials: number;
  /** Annualised Sharpe of every finished attempt in the ledger. */
  trialSharpes: number[];
}

export interface CampaignDsr {
  dsr: number | null;
  trials: number;
  /** Per-observation variance the benchmark was built from, and where it came from. */
  varianceAcrossTrials: number | null;
  varianceSource: 'NULL_MODEL' | 'LEDGER' | null;
  /** The annualised Sharpe the best of `trials` null strategies is expected to show — the bar the candidate had to clear. */
  benchmarkSharpeAnnualised: number | null;
}

/**
 * The campaign's verdict. Same formula as {@link deflatedSharpe}; the variance across trials is
 * `max(1/(n−1), Var[ledger Sharpes]/365)`. The Java class uses the null's variance because a research run only runs its
 * shortlist, and the spread of the selected would understate the spread of all. A campaign ledger holds every attempt,
 * so its spread is the published estimator — but a handful of near-identical edits can make it tiny, which would lower
 * the bar. Taking the larger of the two keeps the correction a correction in both cases.
 */
export function campaignDeflatedSharpe(inputs: CampaignDsrInputs): CampaignDsr {
  const empty: CampaignDsr = { dsr: null, trials: inputs.trials, varianceAcrossTrials: null, varianceSource: null, benchmarkSharpeAnnualised: null };
  const { annualisedSharpe, dailyReturns, skew, excessKurtosis, trials } = inputs;
  if (annualisedSharpe == null || dailyReturns == null || skew == null || excessKurtosis == null) {
    return empty;
  }
  const n = Math.trunc(dailyReturns);
  if (n < MIN_RETURNS || trials < 2 || !Number.isFinite(annualisedSharpe) || !Number.isFinite(skew) || !Number.isFinite(excessKurtosis)) {
    return empty;
  }
  const nullVariance = 1.0 / (n - 1);
  const finite = inputs.trialSharpes.filter((s) => Number.isFinite(s)).map((s) => s / Math.sqrt(TRADING_DAYS_PER_YEAR));
  let ledgerVariance = 0;
  if (finite.length >= 2) {
    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    ledgerVariance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length - 1);
  }
  const useLedger = ledgerVariance > nullVariance;
  const variance = useLedger ? ledgerVariance : nullVariance;
  const benchmark = expectedMaximum(Math.trunc(trials), variance);
  return {
    dsr: probabilisticSharpe(annualisedSharpe / Math.sqrt(TRADING_DAYS_PER_YEAR), benchmark, n, skew, excessKurtosis),
    trials,
    varianceAcrossTrials: variance,
    varianceSource: useLedger ? 'LEDGER' : 'NULL_MODEL',
    benchmarkSharpeAnnualised: benchmark * Math.sqrt(TRADING_DAYS_PER_YEAR),
  };
}
