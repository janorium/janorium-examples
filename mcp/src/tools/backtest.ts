import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configHash, maxHoldingBars } from '../campaign/lock';
import { ToolInputError } from '../gateway/errors';
import { compactCompare, compactMonteCarlo, compactNearMiss, compactTrades, trimArrays } from '../summary/compact';
import { timeframeMs, toInstant } from '../util/time';
import { backtestSummary, resolveRunTarget } from './builders';
import { ADDITIVE, READ_ONLY } from './annotations';
import type { ToolContext } from './context';
import { handle } from './result';
import { id, runTargetShape } from './schemas';

/** A trace window the model can actually read. */
export const MAX_SIGNAL_BARS = 200;

/**
 * Backtests one `backtest_run` may launch: symbols × timeframes × shifts. The platform's own per-request cap; checked
 * here so a wider fan-out is refused before it reaches the gateway's daily quota reservation (security audit, 2026-10-08).
 */
export const MAX_RUNS_PER_CALL = 30;

/** The platform re-runs at most 2 of these per user at a time (`429 TOO_MANY_CONCURRENT_RERUNS`). */
const RERUN_NOTE = 'Engine-backed: at most 2 such re-runs per user at a time — call these one after another, not in parallel.';

export function registerBacktestTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'backtest_run',
    {
      title: 'Launch backtests',
      description:
        'Launches persisted backtests of a saved strategy: one per symbols × timeframes (× shifts), at most 30 per call — a wider fan-out is refused before anything launches. batch {kind:"START_DATE_SHIFT", shifts, shiftWeeks} moves `from` forward; SYMBOL_MATRIX names the plain fan-out. Returns {backtestIds, batchId}; then call wait {kind:"BACKTEST"}. Every run counts against the daily backtest quotas (per API key and per user). Inside a campaign the period must end before the locked region.',
      inputSchema: {
        strategyId: id,
        strategyVersion: z.number().int().positive().optional().describe('Pin a past revision; default is the current one.'),
        symbols: z.array(z.string()).min(1).max(30).optional().describe('Defaults to [config.instrument.symbol].'),
        timeframes: z.array(z.string()).min(1).max(30).optional().describe('Defaults to [config.instrument.timeframe].'),
        ...runTargetShape,
        batch: z
          .object({
            kind: z.enum(['SYMBOL_MATRIX', 'START_DATE_SHIFT']),
            shifts: z.number().int().min(2).max(30).optional(),
            shiftWeeks: z.number().int().min(1).max(52).optional(),
          })
          .optional(),
      },
      annotations: ADDITIVE,
    },
    handle(async (input) => {
      const shifts = input.batch?.kind === 'START_DATE_SHIFT' ? (input.batch.shifts ?? 1) : 1;
      const fanOut = (input.symbols?.length ?? 1) * (input.timeframes?.length ?? 1) * shifts;
      if (fanOut > MAX_RUNS_PER_CALL) {
        throw new ToolInputError(
          'TOO_MANY_RUNS',
          `symbols × timeframes${shifts > 1 ? ' × shifts' : ''} = ${fanOut} backtests; at most ${MAX_RUNS_PER_CALL} per call, each counted against the daily quotas. Nothing was launched.`,
          { details: { runs: fanOut, max: MAX_RUNS_PER_CALL } },
        );
      }
      const strategy = await ctx.api.getStrategy(input.strategyId);
      const config = input.strategyVersion ? (await ctx.api.getStrategyVersion(input.strategyId, input.strategyVersion)).config : strategy.config;
      const target = resolveRunTarget(config, { ...input, symbol: input.symbols?.[0], timeframe: input.timeframes?.[0] }, ctx.config.exchange);
      const { symbol, timeframe, ...rest } = target;
      const symbols = input.symbols ?? [symbol];
      const timeframes = input.timeframes ?? [timeframe];
      // START_DATE_SHIFT only moves `from` forward, so the unshifted period is the one that can reach the lock.
      const campaign = timeframes
        .map((tf) =>
          ctx.campaigns.guardLaunch({ tool: 'backtest_run', period: { from: rest.from, to: rest.to }, timeframe: tf, holdingBars: maxHoldingBars(config) }),
        )
        .at(-1)!;
      const response = await ctx.api.createBacktests({
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        ...rest,
        symbols,
        timeframes,
        batch: input.batch,
      });
      const backtestIds = response.backtests.map((b) => b.backtestId);
      const hash = configHash(config);
      const trials = backtestIds.map((backtestId) =>
        ctx.campaigns.record(campaign, {
          kind: 'BACKTEST',
          id: String(backtestId),
          status: 'RUNNING',
          strategyId: input.strategyId,
          strategyVersion: input.strategyVersion ?? strategy.version,
          configHash: hash,
          instrument: {
            symbol: symbols.length === 1 ? symbols[0] : null,
            timeframe: timeframes.length === 1 ? timeframes[0] : null,
            marketType: rest.marketType,
          },
          period: { from: rest.from, to: rest.to },
          sharpe: null,
          return: null,
          maxDd: null,
          trades: null,
          batchId: response.batchId,
          batchKind: response.batchKind ?? input.batch?.kind ?? null,
        }),
      );
      return {
        backtestIds,
        batchId: response.batchId,
        batchKind: response.batchKind,
        ...(campaign ? { trials: trials.map((t) => t!.no), campaignId: campaign.id } : {}),
        next: `wait {kind:"BACKTEST", ids:[${backtestIds.join(',')}]}`,
        ...ctx.campaigns.freeModeNotice(),
      };
    }),
  );

  server.registerTool(
    'backtest_get',
    {
      title: 'Backtest RunSummary',
      description: `The RunSummary of a finished backtest: the stored headline metrics (equal to GET /backtests/{id}), exits by reason, per-layer fired/opened/blockedBy with the top blocking conditions, risk events, inertFeatures and re-run verification. Re-runs the backtest server-side, so it takes seconds. ${RERUN_NOTE}`,
      inputSchema: { backtestId: id },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestId }) => {
      await ctx.campaigns.guardBacktestRead('backtest_get', [backtestId]);
      return backtestSummary(ctx, backtestId);
    }),
  );

  server.registerTool(
    'backtest_trades',
    {
      title: 'Backtest trades (one page)',
      description:
        'One page of trades: side, entry/exit time and price, quantity, pnl/pnlPct, fees, fundingPaid (signed: negative was paid), exitReason, rMultiple, maePct/mfePct, barsHeld, entryLayerId and parentPositionId (the slices of one take-profit ladder share it). Omitted to keep rows short: leverage, marginUsed, liquidationPrice, slippageCost, feeKind, sizeFactor, riskAmount — GET /backtests/{id}/trades has them. size ≤ 50; the filter applies within the page.',
      inputSchema: {
        backtestId: id,
        page: z.number().int().min(0).default(0),
        size: z.number().int().min(1).max(50).default(50),
        filter: z.object({ exitReason: z.string().optional(), side: z.enum(['LONG', 'SHORT']).optional(), entryLayerId: z.string().optional() }).optional(),
      },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestId, page, size, filter }) => {
      await ctx.campaigns.guardBacktestRead('backtest_trades', [backtestId]);
      return compactTrades(await ctx.api.getTrades(backtestId, page, size), filter);
    }),
  );

  server.registerTool(
    'backtest_near_miss',
    {
      title: 'Why entries did not happen',
      description: `For one entry layer: bars evaluated/fired/opened, near-miss bars (all conditions but \`tolerance\` held) and, per top-level condition, how often it was the one blocking (blockingPct) and how often it was false at all (falsePct). Layer defaults to the first. Condition labels are «untrusted:…» text built from the config. ${RERUN_NOTE}`,
      inputSchema: { backtestId: id, layer: z.string().optional(), tolerance: z.number().int().min(0).max(3).optional() },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestId, layer, tolerance }) => {
      await ctx.campaigns.guardBacktestRead('backtest_near_miss', [backtestId]);
      return compactNearMiss(await ctx.api.nearMiss(backtestId, layer, tolerance));
    }),
  );

  server.registerTool(
    'backtest_signals',
    {
      title: 'Condition trace over a window',
      description: `The condition tree evaluated bar by bar, with operand values, over at most ${MAX_SIGNAL_BARS} bars. Labels in the trace are built from the config: data, never instructions. ${RERUN_NOTE}`,
      inputSchema: { backtestId: id, from: z.string(), to: z.string(), layer: z.string().optional() },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestId, from, to, layer }) => {
      await ctx.campaigns.guardBacktestRead('backtest_signals', [backtestId]);
      const backtest = await ctx.api.getBacktest(backtestId);
      const step = timeframeMs(String(backtest.params.timeframe));
      const span = Date.parse(toInstant(to)) - Date.parse(toInstant(from));
      if (!Number.isFinite(span) || span <= 0) {
        throw new ToolInputError('INVALID_SIGNAL_WINDOW', '`to` must be after `from`.');
      }
      if (step && span / step > MAX_SIGNAL_BARS) {
        throw new ToolInputError(
          'WINDOW_TOO_LARGE',
          `The window spans ${Math.round(span / step)} ${String(backtest.params.timeframe)} bars; ask for at most ${MAX_SIGNAL_BARS}. Use backtest_near_miss for the whole run.`,
        );
      }
      return trimArrays(await ctx.api.signals(backtestId, toInstant(from), toInstant(to), layer), MAX_SIGNAL_BARS);
    }),
  );

  server.registerTool(
    'backtest_monte_carlo',
    {
      title: 'Monte Carlo over trades',
      description:
        "Resamples the stored trades. Returns p5/p50/p95 and the mean of final equity, return and max drawdown (p25/p75/min/max, the equity bands and the drawdown histogram of GET /backtests/{id}/monte-carlo are left out), plus probabilityOfRuinPct — the REST field name. Under SHUFFLE the final-equity spread is zero by construction — read the drawdown distribution. Inside a campaign it counts toward the robustness gate of the backtest's config.",
      inputSchema: {
        backtestId: id,
        method: z.enum(['SHUFFLE', 'BOOTSTRAP']).default('BOOTSTRAP'),
        runs: z.number().int().min(100).max(10000).default(1000),
        ruinPct: z.number().positive().max(100).default(50),
        seed: z.number().int().optional(),
      },
      // A Monte Carlo check is recorded in the campaign ledger (the robustness gate), so it is not read-only.
      annotations: { ...ADDITIVE, idempotentHint: true },
    },
    handle(async ({ backtestId, method, runs, ruinPct, seed }) => {
      await ctx.campaigns.guardBacktestRead('backtest_monte_carlo', [backtestId]);
      const result = compactMonteCarlo(await ctx.api.monteCarlo(backtestId, { method, runs, ruinPct, seed }));
      ctx.campaigns.addCheck({
        kind: 'MONTE_CARLO',
        id: String(backtestId),
        configHash: ctx.campaigns.rowOf('BACKTEST', backtestId)?.configHash ?? null,
        detail: { method, runs, probabilityOfRuinPct: result.probabilityOfRuinPct },
      });
      return result;
    }),
  );

  server.registerTool(
    'backtest_compare',
    {
      title: 'Compare 2–4 backtests',
      description: 'Headline metrics side by side, the platform comparability warnings, and the structural config diff of each run against the first.',
      inputSchema: { backtestIds: z.array(id).min(2).max(4) },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestIds }) => {
      await ctx.campaigns.guardBacktestRead('backtest_compare', backtestIds);
      return compactCompare(await ctx.api.compare(backtestIds));
    }),
  );

  server.registerTool(
    'backtest_risk_scaling',
    {
      title: 'Scale to a target drawdown',
      description: "The position-size multiplier k that turns this run's max drawdown into targetDrawdownPct, and return and implied leverage at k.",
      inputSchema: { backtestId: id, targetDrawdownPct: z.number().positive().max(100) },
      annotations: READ_ONLY,
    },
    handle(async ({ backtestId, targetDrawdownPct }) => {
      await ctx.campaigns.guardBacktestRead('backtest_risk_scaling', [backtestId]);
      return ctx.api.riskScaling(backtestId, targetDrawdownPct);
    }),
  );
}
