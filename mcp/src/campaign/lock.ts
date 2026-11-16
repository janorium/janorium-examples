import { createHash } from 'node:crypto';
import { timeframeMs } from '../util/time';

/** Campaign rule 1: the embargo before the holdout is never shorter than this many bars. */
export const MIN_EMBARGO_BARS = 24;

export interface Period {
  from: string;
  to: string;
}

/**
 * The longest a position of this config may be held, in bars: the largest `maxHoldingBars` anywhere in it (root exit,
 * layer exits). `null` when the config sets none — a position can then be held indefinitely, and only the floor applies.
 */
export function maxHoldingBars(config: unknown): number | null {
  config = substituteParams(config);
  let best: number | null = null;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'maxHoldingBars' && typeof value === 'number' && Number.isFinite(value)) {
          best = Math.max(best ?? 0, value);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(config);
  return best;
}

export function embargoBars(barsNeeded: number | null): number {
  return Math.max(barsNeeded ?? 0, MIN_EMBARGO_BARS);
}

/** Where the locked region begins for a run on `timeframe` that may hold for `bars`: `holdoutFrom − embargo`. */
export function lockStart(holdoutFrom: string, timeframe: string, bars: number): number | null {
  const step = timeframeMs(timeframe);
  if (step === null) {
    return null;
  }
  return Date.parse(holdoutFrom) - bars * step;
}

/** Half-open `[from, to)` against the closed locked region `[lockFrom, lockTo]`. */
export function overlaps(period: Period, lockFrom: number, lockTo: number): boolean {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return from <= lockTo && to > lockFrom;
}

/** Key order is not part of a config's meaning — the platform's storage does not preserve it — so hash it sorted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 16 hex characters of SHA-256 over the canonical JSON — enough to tell two configs apart in one ledger. Hashed after
 * {@link substituteParams}, so writing a number through `params` is not a second trial of the same config.
 */
export function configHash(config: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(substituteParams(config)))
    .digest('hex')
    .slice(0, 16);
}

/** The name of a `{"$param": name}` reference, or `null` when `node` is not one. */
function paramName(node: unknown): string | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null;
  }
  const keys = Object.keys(node);
  const name = (node as Record<string, unknown>).$param;
  return keys.length === 1 && typeof name === 'string' ? name : null;
}

/**
 * Parameter substitution, the same the platform's config normalizer does: every `{"$param": name}` becomes `params[name]` and the root `params` block goes. A config with no `params` block
 * comes back as it is. An unknown name is left in place — the platform rejects that config, so it never reaches a ledger.
 */
export function substituteParams(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !('params' in config)) {
    return config;
  }
  const { params, ...rest } = config as Record<string, unknown>;
  const values = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    const name = paramName(node);
    if (name !== null) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : node;
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    }
    return node;
  };
  return walk(rest);
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
