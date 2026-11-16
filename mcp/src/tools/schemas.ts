import { z } from 'zod';

export const id = z.number().int().positive();
export const marketType = z.enum(['spot', 'futures']);
export const marginMode = z.enum(['ISOLATED', 'CROSS']);
export const instant = z.string().describe('ISO-8601 instant, or a date `YYYY-MM-DD` read as 00:00 UTC.');
/** A request body documented by a reference doc — validated by the platform, passed through here unchanged. */
export const body = z.record(z.string(), z.unknown());

/** A field of a pass-through body read as text: a string stays itself, anything else is `''` (never `[object Object]`). */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The platform's bounds on a run's period (as of 2026-10-08) — quoted so the model does not learn them by 422. */
export const PERIOD_LIMITS =
  'from on or after 2020-01-01, to at most 24 h past now, from before to, at most 500,000 bars per run (422 PERIOD_TOO_EARLY / INVALID_PERIOD / PERIOD_TOO_LONG otherwise).';

/** Optional run-target fields; blanks are filled from the strategy config (`market.*`, `instrument.*`). */
export const runTargetShape = {
  exchange: z.string().optional().describe('Defaults to config.market.exchange, then binance.'),
  marketType: marketType.optional().describe('Defaults to config.market.type.'),
  from: instant.describe(`ISO-8601 instant, or a date \`YYYY-MM-DD\` read as 00:00 UTC. Limits: ${PERIOD_LIMITS}`),
  to: instant,
  initialCapital: z.number().positive().optional().describe('Defaults to 10000.'),
  leverage: z.number().int().min(1).max(125).optional().describe('Futures only. Defaults to config.market.futures.leverage.'),
  marginMode: marginMode.optional(),
  applyFunding: z.boolean().optional(),
};
