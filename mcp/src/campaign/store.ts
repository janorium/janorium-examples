import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export type CampaignStatus = 'ACTIVE' | 'FINALIZED' | 'SUPERSEDED';

/** `OPTIMIZATION` is the launch row; once the run is ranked it is expanded into one `OPTIMIZATION_VARIANT` row per variant. */
export type TrialKind = 'DRY_RUN' | 'BACKTEST' | 'OPTIMIZATION' | 'OPTIMIZATION_VARIANT' | 'RESEARCH';
export type TrialStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

/** Campaign rule 2, one ledger row per attempt: `{no, kind, id, instrument, period, sharpe, return, maxDd, trades, configHash, at}`. */
export interface TrialRow {
  no: number;
  kind: TrialKind;
  id: string;
  status: TrialStatus;
  strategyId: number | null;
  strategyVersion: number | null;
  configHash: string | null;
  instrument: { symbol: string | null; timeframe: string | null; marketType: string | null };
  period: { from: string; to: string };
  sharpe: number | null;
  return: number | null;
  maxDd: number | null;
  trades: number | null;
  at: string;
  /** Backtests launched by one `backtest_run` share it; `START_DATE_SHIFT` is what the robustness gate looks for. */
  batchId?: string | null;
  batchKind?: string | null;
  randomizedEntry?: boolean;
  percentileRank?: number | null;
  /** How many hypotheses this row stands for until it is resolved: an optimizer run's variants, a scan's tests. */
  hypotheses?: number | null;
  /** `OPTIMIZATION` rows: set once the variants have been written as their own rows. */
  expanded?: boolean;
}

export interface CheckRow {
  kind: 'MONTE_CARLO' | 'ANALOG_QUERY';
  id: string;
  configHash: string | null;
  at: string;
  detail?: Record<string, unknown>;
}

export interface Refusal {
  at: string;
  tool: string;
  code: string;
  period: { from: string; to: string } | null;
}

export interface Finalization {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  candidate: { strategyId: number; strategyVersion: number; configHash: string };
  /** `m` frozen at the moment finalize was called — later reads cannot move it. */
  trials: number;
  trialSharpes: number[];
  robustnessGate: 'ENFORCED' | 'DISABLED';
  holdout: { backtestIds: number[]; rows: TrialRow[]; error: string | null };
  inSample: {
    dryRunId: string | null;
    period: { from: string; to: string };
    symbol: string;
    timeframe: string;
    sharpe: number | null;
    dailyReturns: number | null;
    skew: number | null;
    excessKurtosis: number | null;
    error: string | null;
  };
  dsr: number | null;
  varianceAcrossTrials: number | null;
  varianceSource: 'NULL_MODEL' | 'LEDGER' | null;
  benchmarkSharpeAnnualised: number | null;
  caveats: string[];
}

export interface Campaign {
  formatVersion: 1;
  id: string;
  name: string;
  status: CampaignStatus;
  createdAt: string;
  strategyId: number | null;
  symbols: string[];
  timeframes: string[];
  from: string;
  to: string;
  holdoutFrom: string;
  parentCampaignId: string | null;
  /** The parent's `m` at the moment this campaign started: "start over" does not reset the count. */
  inheritedTrials: number;
  robustnessGate: 'ENFORCED' | 'DISABLED';
  supersededBy: string | null;
  trials: TrialRow[];
  checks: CheckRow[];
  refusals: Refusal[];
  finalization: Finalization | null;
}

/** A campaign id is a UUID today; anything outside this alphabet never becomes part of a path. */
export const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isCampaignId(value: unknown): value is string {
  return typeof value === 'string' && CAMPAIGN_ID_PATTERN.test(value);
}

const STATUSES = new Set<CampaignStatus>(['ACTIVE', 'FINALIZED', 'SUPERSEDED']);
const isString = (value: unknown) => typeof value === 'string';
const isIdOrNull = (value: unknown) => value === null || value === undefined || isCampaignId(value);

/**
 * The shape the code relies on, checked on every file read: the ledger is a file anyone with access to the directory can
 * edit, so its contents are input, not state (security audit, 2026-10-08). A file that fails is ignored, never repaired.
 */
function isCampaign(value: unknown): value is Campaign {
  const c = value as Partial<Campaign> | null;
  return (
    !!c &&
    typeof c === 'object' &&
    c.formatVersion === 1 &&
    isCampaignId(c.id) &&
    STATUSES.has(c.status as CampaignStatus) &&
    [c.name, c.createdAt, c.from, c.to, c.holdoutFrom].every(isString) &&
    isIdOrNull(c.parentCampaignId) &&
    isIdOrNull(c.supersededBy) &&
    Array.isArray(c.symbols) &&
    Array.isArray(c.timeframes) &&
    c.symbols.every(isString) &&
    c.timeframes.every(isString) &&
    Array.isArray(c.trials) &&
    Array.isArray(c.checks) &&
    Array.isArray(c.refusals)
  );
}

/**
 * `~/.crypto-backtesting/campaigns/<id>.json`. One file per campaign, rewritten whole on every change
 * through a temp file and a rename, so a crash mid-write leaves the previous ledger rather than half of one. The ledger is
 * small — rows, not series — so synchronous I/O keeps the order of writes the order of calls.
 *
 * Paths come from validated ids only ({@link CAMPAIGN_ID_PATTERN}), never from what a file says about itself: a file
 * whose `id` is not its own name is ignored, so editing one ledger cannot redirect a write to another path.
 */
export class CampaignStore {
  constructor(readonly dir: string) {}

  list(): Campaign[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .filter(isCampaignId)
      .map((id) => this.load(id))
      .filter((campaign): campaign is Campaign => campaign !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  load(id: string): Campaign | null {
    if (!isCampaignId(id)) {
      return null;
    }
    const campaign = this.read(this.fileOf(id));
    return campaign && campaign.id === id ? campaign : null;
  }

  save(campaign: Campaign): void {
    if (!isCampaignId(campaign.id)) {
      throw new Error(`refusing to write a campaign whose id is not a plain id: ${JSON.stringify(String(campaign.id).slice(0, 80))}`);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.fileOf(campaign.id);
    const temp = `${target}.tmp`;
    // A leftover temp file (a crash) is removed; `wx` then refuses to write through anything planted in its place.
    rmSync(temp, { force: true });
    writeFileSync(temp, JSON.stringify(campaign, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  }

  /** `<dir>/<id>.json`, and provably inside `dir` — the id pattern already rules out separators and `..`. */
  private fileOf(id: string): string {
    const root = path.resolve(this.dir);
    const file = path.resolve(root, `${id}.json`);
    if (path.dirname(file) !== root) {
      throw new Error(`campaign path escapes ${root}`);
    }
    return file;
  }

  private read(file: string): Campaign | null {
    try {
      if (!lstatSync(file).isFile()) {
        return null;
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return isCampaign(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
