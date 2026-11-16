import { randomUUID } from 'node:crypto';
import type { PlatformApi } from '../gateway/api';
import { GatewayError, ToolInputError } from '../gateway/errors';
import { awaitJobs } from '../jobs/wait';
import type { Logger } from '../log';
import { untrusted } from '../output/untrusted';
import type { Backtest, Optimization } from '../platform-types';
import { resolveRunTarget } from '../tools/builders';
import { timeframeMs, toInstant } from '../util/time';
import type { NotificationHub } from '../ws/notifications';
import { campaignDeflatedSharpe } from './deflated-sharpe';
import { configHash, embargoBars, isoOf, lockStart, maxHoldingBars, MIN_EMBARGO_BARS, overlaps, type Period } from './lock';
import { CampaignStore, type Campaign, type CheckRow, type Finalization, type TrialRow, type TrialStatus } from './store';

export interface CampaignOptions {
  /**
   * `MCP_REQUIRE_CAMPAIGN=true`: launching anything without an active campaign is refused with `NO_CAMPAIGN`. Off by
   * default (free mode), so a one-off question gets a run; a search is nudged into a campaign by `freeModeNotice`.
   */
  requireCampaign: boolean;
  /** `false` only under `--no-robustness-gate`; recorded in every campaign it applies to. */
  robustnessGate: boolean;
  exchange: string;
  pollIntervalMs: number;
  now?: () => number;
}

export interface LaunchGuard {
  tool: string;
  period: Period;
  timeframe: string;
  /** Bars a position (or a forward horizon) can reach past the end of the period; the embargo is at least this. */
  holdingBars: number | null;
}

export interface CampaignStartInput {
  name: string;
  strategyId?: number;
  symbols: string[];
  timeframes: string[];
  from: string;
  to: string;
  holdoutFrom: string;
  parentCampaignId?: string;
}

export interface FinalizeInput {
  campaignId?: string;
  strategyId: number;
  strategyVersion?: number;
  timeoutSec: number;
}

export type TrialRef = { campaignId: string; no: number };

/** An async dry-run whose event never arrived is not pending forever: after this it is written off as lost. */
const LOST_DRY_RUN_MS = 30 * 60_000;
const MAX_HOLDOUT_RUNS = 30;
const STRATEGY_KINDS = new Set(['DRY_RUN', 'BACKTEST', 'OPTIMIZATION_VARIANT']);
/** Free mode: from this many distinct configs run without a campaign, launch answers carry `campaignNotice`. */
export const FREE_MODE_SEARCH_THRESHOLD = 5;

/**
 * The campaign protocol, enforced in the server rather than asked for in a prompt.
 *
 * One campaign is active per process. Its holdout is locked for every launch and every read, each attempt becomes a row
 * of the ledger, and `finalize` spends the holdout once: the campaign is marked `FINALIZED` on disk **before** the
 * holdout run is launched, so neither a crash nor a timeout can buy a second look.
 */
export class CampaignManager {
  private activeId: string | null = null;
  private readonly backtestParams = new Map<number, Backtest['params']>();
  /** Free mode only: config hashes of the dry-runs and backtests launched without a campaign by this process. */
  private readonly freeConfigs = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly store: CampaignStore,
    private readonly api: PlatformApi,
    private readonly hub: NotificationHub,
    private readonly options: CampaignOptions,
    private readonly log: Logger,
  ) {
    this.now = options.now ?? Date.now;
    // A restarted process picks the campaign back up: restarting must not be a way out of the lock.
    const active = store.list().filter((c) => c.status === 'ACTIVE');
    this.activeId = active.length > 0 ? active[active.length - 1].id : null;
  }

  get requireCampaign(): boolean {
    return this.options.requireCampaign;
  }

  get robustnessGate(): boolean {
    return this.options.robustnessGate;
  }

  active(): Campaign | null {
    if (!this.activeId) {
      return null;
    }
    const campaign = this.store.load(this.activeId);
    if (!campaign || campaign.status !== 'ACTIVE') {
      this.activeId = null;
      return null;
    }
    return campaign;
  }

  load(id: string): Campaign | null {
    return this.store.load(id);
  }

  list(): Campaign[] {
    return this.store.list();
  }

  /** `X-Campaign-Id` on every gateway request while a campaign is active — the platform's trials registry reads it. */
  headers(): Record<string, string> {
    return this.activeId ? { 'X-Campaign-Id': this.activeId } : {};
  }

  /* ── start ─────────────────────────────────────────────────────────────── */

  async start(input: CampaignStartInput): Promise<Campaign> {
    const from = toInstant(input.from);
    const to = toInstant(input.to);
    const holdoutFrom = toInstant(input.holdoutFrom);
    const [f, t, h] = [Date.parse(from), Date.parse(to), Date.parse(holdoutFrom)];
    if (![f, t, h].every(Number.isFinite) || !(f < h && h < t)) {
      throw new ToolInputError('INVALID_CAMPAIGN_PERIOD', 'Need from < holdoutFrom < to, as ISO instants or YYYY-MM-DD dates.');
    }
    if (h < f + (t - f) / 2) {
      throw new ToolInputError(
        'HOLDOUT_TOO_EARLY',
        `holdoutFrom must leave at least half of the period in-sample: on or after ${isoOf(f + Math.ceil((t - f) / 2))}.`,
      );
    }
    const steps = input.timeframes.map((tf) => ({ tf, ms: timeframeMs(tf) }));
    const unknown = steps.filter((s) => s.ms === null).map((s) => s.tf);
    if (unknown.length > 0) {
      throw new ToolInputError('UNKNOWN_TIMEFRAME', `Unknown timeframe(s): ${unknown.join(', ')}.`);
    }
    if (input.symbols.length * input.timeframes.length > MAX_HOLDOUT_RUNS) {
      throw new ToolInputError('CAMPAIGN_TOO_WIDE', `symbols × timeframes is at most ${MAX_HOLDOUT_RUNS} — the holdout is one backtest batch.`);
    }
    const widest = Math.max(...steps.map((s) => s.ms!));
    const lockedFrom = h - MIN_EMBARGO_BARS * widest;
    if (lockedFrom <= f) {
      throw new ToolInputError('NO_IN_SAMPLE_LEFT', 'The embargo before holdoutFrom swallows the whole in-sample period.');
    }

    const all = this.store.list();
    const spent = all.find((c) => c.status === 'FINALIZED' && overlaps({ from: isoOf(lockedFrom), to }, Date.parse(c.holdoutFrom), Date.parse(c.to)));
    if (spent) {
      throw new ToolInputError(
        'HOLDOUT_SPENT',
        `Campaign ${spent.id} (${untrusted(spent.name, 120)}) already spent the holdout ${spent.holdoutFrom} → ${spent.to}. A holdout is looked at once; choose a holdout after ${spent.to}, or treat that period as in-sample.`,
        { status: 409, details: { campaignId: spent.id, holdoutFrom: spent.holdoutFrom, to: spent.to } },
      );
    }

    let parent: Campaign | null = null;
    if (input.parentCampaignId) {
      parent = this.store.load(input.parentCampaignId);
      if (!parent) {
        throw new ToolInputError('CAMPAIGN_NOT_FOUND', `No campaign ${input.parentCampaignId}.`, { status: 404 });
      }
    } else {
      // "Starting over" on data already looked at inherits what was looked at — whether or not the agent says so.
      parent = [...all].reverse().find((c) => overlaps({ from, to }, Date.parse(c.from), Date.parse(c.to))) ?? null;
    }
    if (parent) {
      await this.refresh(parent);
    }

    const campaign: Campaign = {
      formatVersion: 1,
      id: randomUUID(),
      name: input.name,
      status: 'ACTIVE',
      createdAt: isoOf(this.now()),
      strategyId: input.strategyId ?? null,
      symbols: input.symbols,
      timeframes: input.timeframes,
      from,
      to,
      holdoutFrom,
      parentCampaignId: parent?.id ?? null,
      inheritedTrials: parent ? this.trialCount(parent) : 0,
      robustnessGate: this.options.robustnessGate ? 'ENFORCED' : 'DISABLED',
      supersededBy: null,
      trials: [],
      checks: [],
      refusals: [],
      finalization: null,
    };
    const previous = this.active();
    if (previous) {
      previous.status = 'SUPERSEDED';
      previous.supersededBy = campaign.id;
      this.store.save(previous);
    }
    this.store.save(campaign);
    this.activeId = campaign.id;
    this.log.info(`campaign ${campaign.id} started (${campaign.name}); holdout ${holdoutFrom} → ${to}; inherited trials ${campaign.inheritedTrials}`);
    return campaign;
  }

  /* ── the lock ──────────────────────────────────────────────────────────── */

  /** Every launch passes here. Returns the active campaign, `null` in free mode; throws `NO_CAMPAIGN` / `HOLDOUT_LOCKED`. */
  guardLaunch(guard: LaunchGuard): Campaign | null {
    const campaign = this.active();
    if (!campaign) {
      if (this.options.requireCampaign) {
        throw new ToolInputError(
          'NO_CAMPAIGN',
          'This server requires an active campaign for every run (MCP_REQUIRE_CAMPAIGN=true). Call campaign_start with the period and the holdout first — see the iterate_strategy prompt.',
        );
      }
      return null;
    }
    this.checkLock(campaign, guard);
    return campaign;
  }

  /** Reads of runs made elsewhere: free without a campaign, but inside one a holdout run is not readable either. */
  guardRead(tool: string, period: Period, timeframe: string): void {
    const campaign = this.active();
    if (campaign) {
      this.checkLock(campaign, { tool, period, timeframe, holdingBars: null });
    }
  }

  async guardBacktestRead(tool: string, backtestIds: number[]): Promise<void> {
    if (!this.active()) {
      return;
    }
    for (const id of backtestIds) {
      let params = this.backtestParams.get(id);
      if (!params) {
        params = (await this.api.getBacktest(id)).params;
        this.backtestParams.set(id, params);
      }
      this.guardRead(tool, { from: params.from, to: params.to }, String(params.timeframe));
    }
  }

  async guardOptimizationRead(tool: string, runId: number): Promise<void> {
    if (!this.active()) {
      return;
    }
    const optimization = await this.api.getOptimization(runId);
    this.guardRead(tool, { from: optimization.windowSpec.optimizeFrom, to: optimization.windowSpec.optimizeTo }, optimization.timeframe);
  }

  async guardResearchJobRead(tool: string, jobId: number): Promise<void> {
    if (!this.active()) {
      return;
    }
    const job = (await this.api.getResearchJob(jobId)).job;
    if (job.periodFrom && job.periodTo) {
      this.guardRead(tool, { from: job.periodFrom, to: job.periodTo }, String(job.timeframe));
    }
  }

  /** The locked region for a timeframe and a holding horizon — what `campaign_status` shows and a refusal names. */
  lockFor(campaign: Campaign, timeframe: string, holdingBars: number | null): { lockedFrom: string; embargoBars: number } | null {
    const bars = embargoBars(holdingBars);
    const start = lockStart(campaign.holdoutFrom, timeframe, bars);
    return start === null ? null : { lockedFrom: isoOf(start), embargoBars: bars };
  }

  private checkLock(campaign: Campaign, guard: LaunchGuard): void {
    const from = Date.parse(toInstant(guard.period.from));
    const to = Date.parse(toInstant(guard.period.to));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new ToolInputError('INVALID_PERIOD', `${guard.tool}: from/to must be ISO instants inside a campaign — the lock is checked against them.`);
    }
    const lock = this.lockFor(campaign, guard.timeframe, guard.holdingBars);
    if (!lock) {
      throw new ToolInputError('UNKNOWN_TIMEFRAME', `${guard.tool}: unknown timeframe "${guard.timeframe}"; the embargo is measured in its bars.`);
    }
    const period = { from: isoOf(from), to: isoOf(to) };
    if (!overlaps(period, Date.parse(lock.lockedFrom), Date.parse(campaign.to))) {
      return;
    }
    campaign.refusals.push({ at: isoOf(this.now()), tool: guard.tool, code: 'HOLDOUT_LOCKED', period });
    this.store.save(campaign);
    throw new ToolInputError(
      'HOLDOUT_LOCKED',
      `${guard.tool}: ${period.from} → ${period.to} reaches the locked region ${lock.lockedFrom} → ${campaign.to} of campaign ${untrusted(campaign.name, 120)} (holdout from ${campaign.holdoutFrom}, embargo ${lock.embargoBars} × ${guard.timeframe}). End the period at or before ${lock.lockedFrom}. The holdout is run once, by campaign_finalize.`,
      {
        details: {
          campaignId: campaign.id,
          lockedFrom: lock.lockedFrom,
          holdoutFrom: campaign.holdoutFrom,
          lockedTo: campaign.to,
          embargoBars: lock.embargoBars,
          timeframe: guard.timeframe,
        },
      },
    );
  }

  /* ── the ledger ────────────────────────────────────────────────────────── */

  record(campaign: Campaign | null, row: Omit<TrialRow, 'no' | 'at'>): TrialRef | null {
    if (!campaign) {
      if (STRATEGY_KINDS.has(row.kind) && row.configHash) {
        this.freeConfigs.add(row.configHash);
      }
      return null;
    }
    const fresh = this.store.load(campaign.id) ?? campaign;
    const no = fresh.trials.reduce((max, r) => Math.max(max, r.no), 0) + 1;
    fresh.trials.push({ ...row, no, at: isoOf(this.now()) });
    this.store.save(fresh);
    return { campaignId: fresh.id, no };
  }

  /**
   * Free mode answers a one-off question without a campaign, but a search run there has no holdout and no trial count:
   * from the FREE_MODE_SEARCH_THRESHOLD-th distinct config, every launch answer says so. `{}` inside a campaign.
   */
  freeModeNotice(): { campaignNotice?: string } {
    const tried = this.freeConfigs.size;
    if (this.active() || tried < FREE_MODE_SEARCH_THRESHOLD) {
      return {};
    }
    return {
      campaignNotice:
        `${tried} different configs have been run without a campaign in this session. The best of them was picked on the same data it was measured on, so its numbers are optimistic. ` +
        'Before calling a variant good, say so to the user and confirm it in a campaign: campaign_start with a holdout, then campaign_finalize.',
    };
  }

  addCheck(check: Omit<CheckRow, 'at'>): void {
    const campaign = this.active();
    if (!campaign) {
      return;
    }
    campaign.checks.push({ ...check, at: isoOf(this.now()) });
    this.store.save(campaign);
  }

  trialOf(kind: TrialRow['kind'], id: string | number): TrialRef | null {
    const campaign = this.active();
    const row = campaign?.trials.find((r) => r.kind === kind && r.id === String(id));
    return campaign && row ? { campaignId: campaign.id, no: row.no } : null;
  }

  rowOf(kind: TrialRow['kind'], id: string | number): TrialRow | null {
    return this.active()?.trials.find((r) => r.kind === kind && r.id === String(id)) ?? null;
  }

  /** A `dry-run.finished` / `dry-run.failed` payload reached `wait`. */
  completeDryRun(dryRunId: string, status: TrialStatus, payload: Record<string, any> | undefined): void {
    this.update('DRY_RUN', dryRunId, (row) => applyDryRunEvent(row, status, payload));
  }

  /** A finished backtest was read anyway — the ledger takes its numbers without another request. */
  observeBacktest(backtest: Backtest): void {
    this.backtestParams.set(backtest.id, backtest.params);
    if (backtest.status === 'DONE' || backtest.status === 'FAILED') {
      this.update('BACKTEST', backtest.id, (row) => applyBacktest(row, backtest));
    }
  }

  private update(kind: TrialRow['kind'], id: string | number, apply: (row: TrialRow) => void): void {
    const campaign = this.active();
    const row = campaign?.trials.find((r) => r.kind === kind && r.id === String(id));
    if (campaign && row && row.status === 'RUNNING') {
      apply(row);
      this.store.save(campaign);
    }
  }

  /**
   * `m`: distinct strategy configs tried (dry-runs, backtests, optimizer variants), plus the hypotheses of every scan,
   * plus what the parent campaign had tried. A batch over symbols or start dates is one hypothesis, not many — counting
   * the robustness checks as attempts would punish exactly the behaviour the gate asks for.
   */
  trialCount(campaign: Campaign): number {
    const hashes = new Set<string>();
    let hypotheses = 0;
    for (const row of campaign.trials) {
      if ((row.kind === 'DRY_RUN' || row.kind === 'BACKTEST') && row.configHash) {
        hashes.add(row.configHash);
      } else if (row.kind === 'OPTIMIZATION_VARIANT') {
        hashes.add(`variant:${row.id}`);
      } else if (row.kind === 'OPTIMIZATION' || row.kind === 'RESEARCH') {
        hypotheses += row.hypotheses ?? 0;
      }
    }
    return campaign.inheritedTrials + hashes.size + hypotheses;
  }

  trialSharpes(campaign: Campaign): number[] {
    return campaign.trials.filter((r) => STRATEGY_KINDS.has(r.kind) && r.status === 'DONE' && typeof r.sharpe === 'number').map((r) => r.sharpe as number);
  }

  /** Fills every row still `RUNNING` from REST (or the socket's record), and expands finished optimizer runs. */
  async refresh(campaign: Campaign): Promise<Campaign> {
    let changed = false;
    for (const row of [...campaign.trials]) {
      if (row.status !== 'RUNNING') {
        continue;
      }
      try {
        changed = (await this.refreshRow(campaign, row)) || changed;
      } catch (error) {
        this.log.warn(
          `campaign ${campaign.id}: could not refresh trial ${row.no} (${row.kind} ${row.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (campaign.finalization?.status === 'RUNNING') {
      changed = (await this.refreshFinalization(campaign)) || changed;
    }
    if (changed) {
      this.store.save(campaign);
    }
    return campaign;
  }

  private async refreshRow(campaign: Campaign, row: TrialRow): Promise<boolean> {
    switch (row.kind) {
      case 'BACKTEST': {
        const backtest = await this.api.getBacktest(Number(row.id));
        this.backtestParams.set(backtest.id, backtest.params);
        if (backtest.status !== 'DONE' && backtest.status !== 'FAILED') {
          return false;
        }
        applyBacktest(row, backtest);
        return true;
      }
      case 'DRY_RUN': {
        const event = this.hub.result('DRY_RUN', row.id);
        if (event) {
          applyDryRunEvent(row, event.status, event.payload);
          return true;
        }
        if (this.now() - Date.parse(row.at) > LOST_DRY_RUN_MS) {
          row.status = 'FAILED';
          return true;
        }
        return false;
      }
      case 'OPTIMIZATION': {
        const optimization = await this.api.getOptimization(Number(row.id));
        if (optimization.status === 'FAILED' || optimization.status === 'CANCELLED') {
          row.status = optimization.status;
          return true;
        }
        if (optimization.status !== 'DONE') {
          return false;
        }
        await this.expandOptimization(campaign, row, optimization);
        return true;
      }
      case 'RESEARCH': {
        const job = (await this.api.getResearchJob(Number(row.id))).job;
        if (job.status === 'FAILED' || job.status === 'CANCELLED') {
          row.status = job.status;
          return true;
        }
        if (job.status !== 'DONE' || job.runId === null) {
          return false;
        }
        const run = await this.api.getResearchRun(job.runId);
        row.hypotheses = hypothesesOf(run.report.meta as unknown as Record<string, unknown>);
        row.status = 'DONE';
        return true;
      }
      default:
        return false;
    }
  }

  private async expandOptimization(campaign: Campaign, row: TrialRow, optimization: Optimization): Promise<void> {
    const leaderboard = await this.api.leaderboard(optimization.id, Math.max(optimization.variantsTotal, 1));
    let no = campaign.trials.reduce((max, r) => Math.max(max, r.no), 0);
    const at = isoOf(this.now());
    for (const item of leaderboard.items) {
      const aggregates = item.testAggregates;
      campaign.trials.push({
        no: ++no,
        kind: 'OPTIMIZATION_VARIANT',
        id: `${optimization.id}#${item.variantIdx}`,
        status: item.status === 'DONE' ? 'DONE' : 'FAILED',
        strategyId: optimization.sourceStrategyId,
        strategyVersion: optimization.sourceStrategyVersion,
        configHash: configHash({ base: row.configHash, paramValues: item.paramValues }),
        instrument: { symbol: optimization.symbol, timeframe: optimization.timeframe, marketType: optimization.marketType },
        period: { from: optimization.windowSpec.optimizeFrom, to: optimization.windowSpec.optimizeTo },
        sharpe: aggregates?.sharpeRatio ?? null,
        return: aggregates?.totalReturnPct ?? null,
        maxDd: aggregates?.maxDrawdownPct ?? null,
        trades: aggregates?.tradesCountAvg ?? null,
        at,
      });
    }
    // Variants the leaderboard page did not carry still count: the launch row keeps them as hypotheses.
    row.hypotheses = Math.max(0, Math.max(optimization.variantsTotal, leaderboard.total) - leaderboard.items.length);
    row.expanded = true;
    row.status = 'DONE';
  }

  /* ── the robustness gate ───────────────────────────────────────────────── */

  /** Campaign rule 4, per candidate config: a date-shift batch, a randomized-entry dry-run and a Monte Carlo, all of it. */
  gate(campaign: Campaign, candidateHash: string): string[] {
    const rows = campaign.trials.filter((r) => r.configHash === candidateHash && r.status === 'DONE');
    const missing: string[] = [];
    if (!rows.some((r) => r.kind === 'BACKTEST' && r.batchKind === 'START_DATE_SHIFT')) {
      missing.push('START_DATE_SHIFT');
    }
    if (!rows.some((r) => r.kind === 'DRY_RUN' && r.randomizedEntry)) {
      missing.push('RANDOMIZED_ENTRY');
    }
    if (!campaign.checks.some((c) => c.kind === 'MONTE_CARLO' && c.configHash === candidateHash)) {
      missing.push('MONTE_CARLO');
    }
    return missing;
  }

  /* ── finalize ──────────────────────────────────────────────────────────── */

  async finalize(input: FinalizeInput): Promise<Record<string, unknown>> {
    const campaign = this.target(input.campaignId);
    if (campaign.status === 'FINALIZED') {
      throw new ToolInputError(
        'CAMPAIGN_FINALIZED',
        `Campaign ${untrusted(campaign.name, 120)} was finalized at ${campaign.finalization?.startedAt ?? '?'}; its holdout is spent. Read campaign://${campaign.id}/ledger for the result. A new campaign needs a holdout after ${campaign.to}.`,
        { status: 409, details: { campaignId: campaign.id } },
      );
    }
    if (campaign.status === 'SUPERSEDED') {
      throw new ToolInputError('CAMPAIGN_SUPERSEDED', `Campaign ${campaign.id} was superseded by ${campaign.supersededBy}; finalize that one.`, {
        status: 409,
      });
    }
    await this.refresh(campaign);
    const pending = campaign.trials.filter((r) => r.status === 'RUNNING');
    if (pending.length > 0) {
      throw new ToolInputError('TRIALS_PENDING', 'Some attempts have not finished, so the number of trials is not known yet. wait for them, then finalize.', {
        details: { running: pending.map((r) => ({ no: r.no, kind: r.kind, id: r.id })) },
      });
    }

    const strategy = await this.api.getStrategy(input.strategyId);
    const version = input.strategyVersion ?? strategy.version;
    const config = input.strategyVersion ? (await this.api.getStrategyVersion(input.strategyId, input.strategyVersion)).config : strategy.config;
    const hash = configHash(config);
    if (!campaign.trials.some((r) => r.configHash === hash && r.status === 'DONE' && (r.kind === 'DRY_RUN' || r.kind === 'BACKTEST'))) {
      throw new ToolInputError(
        'CANDIDATE_NOT_IN_LEDGER',
        `Strategy #${input.strategyId} v${version} (config ${hash}) was never run in-sample in this campaign. A candidate is chosen from the attempts, not added at the end.`,
        { details: { configHash: hash } },
      );
    }
    if (this.options.robustnessGate) {
      const missing = this.gate(campaign, hash);
      if (missing.length > 0) {
        throw new ToolInputError(
          'ROBUSTNESS_MISSING',
          `Before the holdout, the candidate needs: ${missing.join(', ')} — backtest_run with batch START_DATE_SHIFT, strategy_dry_run with randomizedEntry, backtest_monte_carlo on one of its backtests. All on this exact config.`,
          { details: { missing, configHash: hash } },
        );
      }
    }

    const primary = { symbol: campaign.symbols[0], timeframe: campaign.timeframes[0] };
    const lock = this.lockFor(campaign, primary.timeframe, maxHoldingBars(config))!;
    const m = this.trialCount(campaign);
    const finalization: Finalization = {
      status: 'RUNNING',
      startedAt: isoOf(this.now()),
      finishedAt: null,
      candidate: { strategyId: input.strategyId, strategyVersion: version, configHash: hash },
      trials: m,
      trialSharpes: this.trialSharpes(campaign),
      robustnessGate: this.options.robustnessGate ? 'ENFORCED' : 'DISABLED',
      holdout: { backtestIds: [], rows: [], error: null },
      inSample: {
        dryRunId: null,
        period: { from: campaign.from, to: lock.lockedFrom },
        symbol: primary.symbol,
        timeframe: primary.timeframe,
        sharpe: null,
        dailyReturns: null,
        skew: null,
        excessKurtosis: null,
        error: null,
      },
      dsr: null,
      varianceAcrossTrials: null,
      varianceSource: null,
      benchmarkSharpeAnnualised: null,
      caveats: [],
    };
    // Spent from this line on: written before anything is launched.
    campaign.status = 'FINALIZED';
    campaign.finalization = finalization;
    this.store.save(campaign);
    this.activeId = null;

    const holdoutTarget = resolveRunTarget(config, { ...primary, from: campaign.holdoutFrom, to: campaign.to }, this.options.exchange);
    try {
      const { exchange, marketType, from, to, initialCapital, leverage, marginMode, applyFunding } = holdoutTarget;
      const response = await this.api.createBacktests({
        strategyId: input.strategyId,
        strategyVersion: version,
        exchange,
        marketType,
        from,
        to,
        initialCapital,
        leverage,
        marginMode,
        applyFunding,
        symbols: campaign.symbols,
        timeframes: campaign.timeframes,
      });
      finalization.holdout.backtestIds = response.backtests.map((b) => b.backtestId);
    } catch (error) {
      if (error instanceof GatewayError) {
        // The gateway answered and refused: nothing ran, nothing was seen. Give the holdout back.
        campaign.status = 'ACTIVE';
        campaign.finalization = null;
        this.store.save(campaign);
        this.activeId = campaign.id;
        throw error;
      }
      // No answer at all: the batch may be running. The holdout counts as spent.
      finalization.holdout.error = error instanceof Error ? error.message : String(error);
      finalization.caveats.push('HOLDOUT_LAUNCH_UNCONFIRMED');
    }

    try {
      const inSample = resolveRunTarget(config, { ...primary, from: campaign.from, to: lock.lockedFrom }, this.options.exchange);
      finalization.inSample.dryRunId = (await this.api.dryRun({ strategyId: input.strategyId, config, ...inSample })).dryRunId;
    } catch (error) {
      finalization.inSample.error = error instanceof Error ? error.message : String(error);
    }
    this.store.save(campaign);

    const deadline = input.timeoutSec * 1000;
    const deps = { hub: this.hub, poll: this.backtestPoller(), pollIntervalMs: this.options.pollIntervalMs };
    await Promise.all([
      finalization.holdout.backtestIds.length > 0 ? awaitJobs(deps, 'BACKTEST', finalization.holdout.backtestIds.map(String), deadline) : Promise.resolve([]),
      finalization.inSample.dryRunId ? awaitJobs(deps, 'DRY_RUN', [finalization.inSample.dryRunId], deadline) : Promise.resolve([]),
    ]);
    await this.refreshFinalization(campaign);
    this.store.save(campaign);
    return this.finalizationView(campaign);
  }

  private target(campaignId: string | undefined): Campaign {
    if (campaignId) {
      const campaign = this.store.load(campaignId);
      if (!campaign) {
        throw new ToolInputError('CAMPAIGN_NOT_FOUND', `No campaign ${campaignId}.`, { status: 404 });
      }
      return campaign;
    }
    const active = this.active();
    if (active) {
      return active;
    }
    const latest = this.store.list().at(-1);
    if (latest?.status === 'FINALIZED') {
      return latest;
    }
    throw new ToolInputError('NO_CAMPAIGN', 'There is no active campaign to finalize. campaign_start first.');
  }

  private backtestPoller() {
    return async (_kind: string, id: string) => {
      const status = (await this.api.getBacktest(Number(id))).status;
      return status === 'DONE' || status === 'FAILED' ? status : null;
    };
  }

  private async refreshFinalization(campaign: Campaign): Promise<boolean> {
    const fin = campaign.finalization;
    if (!fin || fin.status !== 'RUNNING') {
      return false;
    }
    const rows: TrialRow[] = [];
    let holdoutSettled = true;
    for (const id of fin.holdout.backtestIds) {
      try {
        const backtest = await this.api.getBacktest(id);
        const row: TrialRow = blankRow('BACKTEST', String(id), fin.candidate, backtest.params, 0, fin.startedAt);
        if (backtest.status === 'DONE' || backtest.status === 'FAILED') {
          applyBacktest(row, backtest);
        } else {
          holdoutSettled = false;
        }
        rows.push(row);
      } catch (error) {
        holdoutSettled = false;
        this.log.warn(`campaign ${campaign.id}: holdout backtest ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    fin.holdout.rows = rows;

    let inSampleSettled = fin.inSample.dryRunId === null;
    if (fin.inSample.dryRunId) {
      const event = this.hub.result('DRY_RUN', fin.inSample.dryRunId);
      if (event?.status === 'DONE') {
        const summary = (event.payload.summary ?? {}) as Record<string, unknown>;
        fin.inSample.sharpe = numberOrNull(summary.sharpeRatio);
        fin.inSample.skew = numberOrNull(summary.skew);
        fin.inSample.excessKurtosis = numberOrNull(summary.kurtosis);
        fin.inSample.dailyReturns = numberOrNull(event.payload.dailyReturns);
        inSampleSettled = true;
      } else if (event) {
        fin.inSample.error = String(event.payload.message ?? event.payload.errorCode ?? event.status);
        inSampleSettled = true;
      } else if (this.now() - Date.parse(fin.startedAt) > LOST_DRY_RUN_MS) {
        fin.inSample.error = 'dry-run.finished never arrived';
        inSampleSettled = true;
      }
    }

    const verdict = campaignDeflatedSharpe({
      annualisedSharpe: fin.inSample.sharpe,
      dailyReturns: fin.inSample.dailyReturns,
      skew: fin.inSample.skew,
      excessKurtosis: fin.inSample.excessKurtosis,
      trials: fin.trials,
      trialSharpes: fin.trialSharpes,
    });
    fin.dsr = verdict.dsr;
    fin.varianceAcrossTrials = verdict.varianceAcrossTrials;
    fin.varianceSource = verdict.varianceSource;
    fin.benchmarkSharpeAnnualised = verdict.benchmarkSharpeAnnualised;

    if (holdoutSettled && inSampleSettled) {
      fin.status = fin.holdout.backtestIds.length > 0 && rows.every((r) => r.status === 'DONE') ? 'DONE' : 'FAILED';
      fin.finishedAt = isoOf(this.now());
      const caveats = new Set(fin.caveats);
      if (fin.dsr === null) {
        caveats.add(fin.trials < 2 ? 'DSR_UNDEFINED_FEWER_THAN_TWO_TRIALS' : 'DSR_INPUTS_UNAVAILABLE');
      }
      if (fin.robustnessGate === 'DISABLED') {
        caveats.add('ROBUSTNESS_GATE_DISABLED');
      }
      if (campaign.symbols.length * campaign.timeframes.length > 1) {
        caveats.add('DSR_ON_FIRST_INSTRUMENT_ONLY');
      }
      fin.caveats = [...caveats];
    }
    return true;
  }

  finalizationView(campaign: Campaign): Record<string, unknown> {
    const fin = campaign.finalization!;
    return {
      campaignId: campaign.id,
      status: fin.status,
      candidate: fin.candidate,
      trials: fin.trials,
      inheritedTrials: campaign.inheritedTrials,
      dsr: fin.dsr,
      dsrBasis: {
        inSample: { ...fin.inSample, error: untrusted(fin.inSample.error) },
        benchmarkSharpeAnnualised: fin.benchmarkSharpeAnnualised,
        varianceAcrossTrials: fin.varianceAcrossTrials,
        varianceSource: fin.varianceSource,
      },
      holdout: {
        period: { from: campaign.holdoutFrom, to: campaign.to },
        backtestIds: fin.holdout.backtestIds,
        results: fin.holdout.rows.map(rowView),
        error: untrusted(fin.holdout.error),
      },
      sharpeDistribution: distribution(fin.trialSharpes),
      robustnessGate: fin.robustnessGate,
      caveats: fin.caveats,
      ...(fin.status === 'RUNNING' ? { next: 'The holdout is still running; campaign_status refreshes it. finalize is not called again.' } : {}),
      read: `campaign://${campaign.id}/ledger`,
    };
  }

  /* ── views ─────────────────────────────────────────────────────────────── */

  async status(campaignId?: string, candidate?: { strategyId: number; strategyVersion?: number }): Promise<Record<string, unknown>> {
    const campaign = campaignId ? this.store.load(campaignId) : (this.active() ?? this.store.list().at(-1) ?? null);
    if (!campaign) {
      return {
        active: null,
        requireCampaign: this.options.requireCampaign,
        note: 'No campaign yet. campaign_start reserves the holdout before anything is run.',
      };
    }
    await this.refresh(campaign);
    const view: Record<string, unknown> = { ...this.ledger(campaign, 40), requireCampaign: this.options.requireCampaign };
    if (candidate && campaign.status === 'ACTIVE') {
      const config = candidate.strategyVersion
        ? (await this.api.getStrategyVersion(candidate.strategyId, candidate.strategyVersion)).config
        : (await this.api.getStrategy(candidate.strategyId)).config;
      const hash = configHash(config);
      view.candidate = {
        strategyId: candidate.strategyId,
        strategyVersion: candidate.strategyVersion ?? null,
        configHash: hash,
        inLedger: campaign.trials.some((r) => r.configHash === hash && r.status === 'DONE'),
        robustnessMissing: this.gate(campaign, hash),
        robustnessGate: this.options.robustnessGate ? 'ENFORCED' : 'DISABLED',
      };
    }
    return view;
  }

  /** The compact ledger: header, lock, `m`, the Sharpe distribution, the last rows, the finalization. */
  ledger(campaign: Campaign, lastRows = 200): Record<string, unknown> {
    const variants = campaign.trials.filter((r) => r.kind === 'OPTIMIZATION_VARIANT');
    const others = campaign.trials.filter((r) => r.kind !== 'OPTIMIZATION_VARIANT');
    const byRun = new Map<string, TrialRow[]>();
    for (const v of variants) {
      const runId = v.id.split('#')[0];
      byRun.set(runId, [...(byRun.get(runId) ?? []), v]);
    }
    return {
      campaignId: campaign.id,
      name: untrusted(campaign.name, 120),
      status: campaign.status,
      createdAt: campaign.createdAt,
      strategyId: campaign.strategyId,
      symbols: campaign.symbols,
      timeframes: campaign.timeframes,
      period: { from: campaign.from, to: campaign.to },
      holdoutFrom: campaign.holdoutFrom,
      locks: campaign.timeframes.map((tf) => ({
        timeframe: tf,
        ...this.lockFor(campaign, tf, null),
        note: 'a config with a longer maxHoldingBars moves lockedFrom earlier',
      })),
      parentCampaignId: campaign.parentCampaignId,
      supersededBy: campaign.supersededBy,
      robustnessGate: campaign.robustnessGate,
      trials: this.trialCount(campaign),
      inheritedTrials: campaign.inheritedTrials,
      attempts: campaign.trials.length,
      sharpeDistribution: distribution(this.trialSharpes(campaign)),
      rows: others.slice(-lastRows).map(rowView),
      rowsOmitted: Math.max(0, others.length - lastRows),
      optimizerVariants: [...byRun.entries()].map(([runId, rows]) => ({
        runId: Number(runId),
        variants: rows.length,
        sharpe: distribution(rows.filter((r) => typeof r.sharpe === 'number').map((r) => r.sharpe as number)),
        best: [...rows]
          .filter((r) => typeof r.sharpe === 'number')
          .sort((a, b) => (b.sharpe as number) - (a.sharpe as number))
          .slice(0, 3)
          .map(rowView),
      })),
      checks: campaign.checks.slice(-50),
      refusals: { count: campaign.refusals.length, last: campaign.refusals.slice(-5) },
      finalization: campaign.finalization ? this.finalizationView(campaign) : null,
    };
  }
}

/* ── row helpers ─────────────────────────────────────────────────────────── */

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function applyBacktest(row: TrialRow, backtest: Backtest): void {
  const metrics = (backtest.metrics ?? {}) as unknown as Record<string, unknown>;
  row.status = backtest.status === 'DONE' ? 'DONE' : 'FAILED';
  row.instrument = { symbol: backtest.params.symbol, timeframe: String(backtest.params.timeframe), marketType: backtest.params.marketType };
  row.period = { from: backtest.params.from, to: backtest.params.to };
  row.sharpe = numberOrNull(metrics.sharpeRatio);
  row.return = numberOrNull(metrics.totalReturnPct);
  row.maxDd = numberOrNull(metrics.maxDrawdownPct);
  row.trades = numberOrNull(metrics.tradesCount);
}

function applyDryRunEvent(row: TrialRow, status: TrialStatus, payload: Record<string, any> | undefined): void {
  row.status = status;
  if (status !== 'DONE' || !payload) {
    return;
  }
  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  row.sharpe = numberOrNull(summary.sharpeRatio);
  row.return = numberOrNull(summary.totalReturnPct);
  row.maxDd = numberOrNull(summary.maxDrawdownPct);
  row.trades = numberOrNull(summary.tradesCount);
  if (payload.randomizedEntry) {
    row.percentileRank = numberOrNull(payload.randomizedEntry.percentileRank);
  }
}

function blankRow(kind: TrialRow['kind'], id: string, candidate: Finalization['candidate'], params: Backtest['params'], no: number, at: string): TrialRow {
  return {
    no,
    kind,
    id,
    status: 'RUNNING',
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    configHash: candidate.configHash,
    instrument: { symbol: params.symbol, timeframe: String(params.timeframe), marketType: params.marketType },
    period: { from: params.from, to: params.to },
    sharpe: null,
    return: null,
    maxDd: null,
    trades: null,
    at,
  };
}

export function hypothesesOf(meta: Record<string, unknown> | null | undefined): number {
  const n = (key: string) => (typeof meta?.[key] === 'number' ? meta[key] : 0);
  return n('eventHypotheses') + n('featureHypotheses') + n('sliceHypotheses') + n('pairHypotheses');
}

function rowView(row: TrialRow) {
  return {
    no: row.no,
    kind: row.kind,
    id: row.id,
    status: row.status,
    instrument: `${row.instrument.symbol ?? '?'} ${row.instrument.timeframe ?? '?'}`,
    period: `${row.period.from} → ${row.period.to}`,
    sharpe: row.sharpe,
    return: row.return,
    maxDd: row.maxDd,
    trades: row.trades,
    configHash: row.configHash,
    ...(row.batchKind ? { batchKind: row.batchKind } : {}),
    ...(row.randomizedEntry ? { randomizedEntry: true, percentileRank: row.percentileRank ?? null } : {}),
    ...(row.hypotheses ? { hypotheses: row.hypotheses } : {}),
    at: row.at,
  };
}

function distribution(values: number[]) {
  if (values.length === 0) {
    return { n: 0, mean: null, std: null, min: null, max: null };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = values.length > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)) : null;
  return { n: values.length, mean, std, min: Math.min(...values), max: Math.max(...values) };
}
