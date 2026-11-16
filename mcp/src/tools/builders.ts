import { ToolInputError } from '../gateway/errors';
import type { MarginMode, MarketType, Strategy } from '../platform-types';
import { compactOptimization, compactResearchReport } from '../summary/compact';
import { fromDocument, type RunSummary } from '../summary/run-summary';
import { headline } from '../summary/shapes';
import { toInstant } from '../util/time';
import type { ToolContext } from './context';

/** The run target a dry-run or a backtest needs, with every blank filled from the strategy's own config. */
export interface RunTarget {
  exchange: string;
  marketType: MarketType;
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  initialCapital: number;
  leverage?: number;
  marginMode?: MarginMode;
  applyFunding?: boolean;
}

export interface RunTargetInput {
  exchange?: string;
  marketType?: MarketType;
  symbol?: string;
  timeframe?: string;
  from: string;
  to: string;
  initialCapital?: number;
  leverage?: number;
  marginMode?: MarginMode;
  applyFunding?: boolean;
}

export const DEFAULT_INITIAL_CAPITAL = 10_000;

/**
 * Defaults come from the config, the way the editor fills its run form: `market.type`, `market.exchange`,
 * `market.futures.*` and `instrument.*` (`docs://strategy-config-reference`). A value the caller gave always wins.
 */
export function resolveRunTarget(config: unknown, input: RunTargetInput, fallbackExchange: string): RunTarget {
  const c = (config ?? {}) as { market?: { type?: string; exchange?: string; futures?: Record<string, unknown> }; instrument?: Record<string, unknown> };
  const marketType = (input.marketType ?? c.market?.type) as MarketType | undefined;
  const symbol = input.symbol ?? (c.instrument?.symbol as string | undefined);
  const timeframe = input.timeframe ?? (c.instrument?.timeframe as string | undefined);
  if (!marketType || !symbol || !timeframe) {
    throw new ToolInputError('RUN_TARGET_INCOMPLETE', 'marketType, symbol and timeframe are required when the strategy config does not name them.');
  }
  const target: RunTarget = {
    exchange: input.exchange ?? c.market?.exchange ?? fallbackExchange,
    marketType,
    symbol,
    timeframe,
    from: toInstant(input.from),
    to: toInstant(input.to),
    initialCapital: input.initialCapital ?? DEFAULT_INITIAL_CAPITAL,
  };
  if (marketType === 'futures') {
    const futures = c.market?.futures ?? {};
    target.leverage = input.leverage ?? (futures.leverage as number | undefined) ?? 1;
    target.marginMode = input.marginMode ?? (futures.marginMode as MarginMode | undefined) ?? 'ISOLATED';
    target.applyFunding = input.applyFunding ?? (futures.applyFunding as boolean | undefined) ?? true;
  }
  return target;
}

export async function loadStrategy(ctx: ToolContext, strategyId: number): Promise<Strategy> {
  return ctx.api.getStrategy(strategyId);
}

/**
 * Why a FAILED run failed — the report's `errorCode` / `errorMessage`. A FAILED run used to come back as
 * "not finished yet", which sent an agent into waiting on a run that would never finish.
 */
function failure(backtest: { errorCode?: string | null; errorMessage?: string | null }) {
  return {
    errorCode: backtest.errorCode ?? null,
    errorMessage: backtest.errorMessage ?? null,
    note: 'The run failed and has no report. errorCode says why; re-running the same request fails the same way unless it is INTERNAL_ERROR.',
  };
}

/** `backtest_get`: the report's stored metrics, plus everything the summary re-run adds. */
export async function backtestSummary(ctx: ToolContext, backtestId: number): Promise<RunSummary | Record<string, unknown>> {
  const backtest = await ctx.api.getBacktest(backtestId);
  ctx.campaigns.observeBacktest(backtest);
  if (backtest.status === 'FAILED') {
    return { backtestId, status: backtest.status, ...failure(backtest) };
  }
  if (backtest.status !== 'DONE') {
    return { backtestId, status: backtest.status, note: 'Not finished yet — call wait with kind BACKTEST, then backtest_get again.' };
  }
  const document = await ctx.api.getBacktestSummary(backtestId);
  const summary = fromDocument(document, backtest);
  summary.trial = ctx.campaigns.trialOf('BACKTEST', backtestId);
  return summary;
}

/** One compact row per run, for a batch — a full summary per run would re-run every backtest of the batch. */
export async function backtestRow(ctx: ToolContext, backtestId: number) {
  const backtest = await ctx.api.getBacktest(backtestId);
  ctx.campaigns.observeBacktest(backtest);
  return {
    backtestId,
    trial: ctx.campaigns.trialOf('BACKTEST', backtestId),
    status: backtest.status,
    instrument: { symbol: backtest.params.symbol, timeframe: backtest.params.timeframe, marketType: backtest.params.marketType },
    period: { from: backtest.params.from, to: backtest.params.to },
    metrics: backtest.status === 'DONE' ? headline(backtest.metrics as unknown as Record<string, unknown>) : null,
    ...(backtest.status === 'FAILED' ? { errorCode: backtest.errorCode ?? null, errorMessage: backtest.errorMessage ?? null } : {}),
  };
}

export async function optimizationSummary(ctx: ToolContext, runId: number, top: number) {
  const optimization = await ctx.api.getOptimization(runId);
  const hasLeaderboard = ['RANKING', 'FINALISTS', 'DONE'].includes(optimization.status) || optimization.diagnosis !== null;
  const leaderboard = hasLeaderboard ? await ctx.api.leaderboard(runId, top) : null;
  return compactOptimization(optimization, leaderboard, top);
}

export async function researchJobSummary(ctx: ToolContext, jobId: number, top = 10) {
  const detail = await ctx.api.getResearchJob(jobId);
  const job = detail.job;
  const header = {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    pct: job.pct,
    tasks: { total: job.tasksTotal, done: job.tasksDone, failed: job.tasksFailed },
    symbols: job.symbols,
    timeframe: job.timeframe,
    period: { from: job.periodFrom, to: job.periodTo },
    runId: job.runId,
    errorCode: job.errorCode,
  };
  if (job.status !== 'DONE' || job.runId === null) {
    return header;
  }
  const run = await ctx.api.getResearchRun(job.runId);
  return { ...header, report: compactResearchReport({ ...run.report, runId: job.runId }, top) };
}
