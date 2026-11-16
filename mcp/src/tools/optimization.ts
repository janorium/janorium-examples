import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configHash, maxHoldingBars } from '../campaign/lock';
import type { Campaign } from '../campaign/store';
import { untrusted } from '../output/untrusted';
import { ADDITIVE, DESTRUCTIVE, READ_ONLY } from './annotations';
import { optimizationSummary } from './builders';
import type { ToolContext } from './context';
import { handle } from './result';
import { body, id, str } from './schemas';

export function registerOptimizationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'optimization_create',
    {
      title: 'Start an optimizer run',
      description:
        'POST /optimizations with a body exactly as docs://optimizer-run-reference describes (searchSpace, windowSpec, scoring). Returns {runId}; then wait {kind:"OPTIMIZATION"}. At most 2 active runs per user. Inside a campaign windowSpec (optimize window and any oosFrom/oosTo) must end before the locked region, and every variant becomes a ledger trial.',
      inputSchema: { request: body.describe('CreateOptimizationRequest (docs://optimizer-run-reference).') },
      annotations: ADDITIVE,
    },
    handle(async ({ request }) => {
      const windowSpec = (request.windowSpec ?? {}) as Record<string, unknown>;
      const timeframe = str(request.timeframe);
      const baseConfig = ctx.campaigns.active() ? await loadBaseConfig(ctx, request) : null;
      const holdingBars = maxHoldingBars(baseConfig);
      const campaign = ctx.campaigns.guardLaunch({
        tool: 'optimization_create',
        period: { from: str(windowSpec.optimizeFrom), to: str(windowSpec.optimizeTo) },
        timeframe,
        holdingBars,
      });
      if (campaign && (windowSpec.oosFrom || windowSpec.oosTo)) {
        // The OOS slice is run at promotion — inside a campaign it is in-sample validation, never the holdout.
        ctx.campaigns.guardLaunch({
          tool: 'optimization_create',
          period: { from: str(windowSpec.oosFrom), to: str(windowSpec.oosTo) },
          timeframe,
          holdingBars,
        });
      }
      const r = await ctx.api.createOptimization(request);
      const trial = ctx.campaigns.record(campaign, {
        kind: 'OPTIMIZATION',
        id: String(r.optimizationRunId),
        status: 'RUNNING',
        strategyId: typeof request.strategyId === 'number' ? request.strategyId : null,
        strategyVersion: typeof request.strategyVersion === 'number' ? request.strategyVersion : null,
        configHash: baseConfig ? configHash(baseConfig) : null,
        instrument: { symbol: str(request.symbol) || null, timeframe: timeframe || null, marketType: str(request.marketType) || null },
        period: { from: str(windowSpec.optimizeFrom), to: str(windowSpec.optimizeTo) },
        sharpe: null,
        return: null,
        maxDd: null,
        trades: null,
        hypotheses: r.variantsTotal,
      });
      return {
        runId: r.optimizationRunId,
        status: r.status,
        variantsTotal: r.variantsTotal,
        windowsTotal: r.windowsTotal,
        variantRunsTotal: r.variantRunsTotal,
        warnings: (r.warnings ?? []).map((w) => ({ code: w.code, message: untrusted(w.message) })),
        ...(trial ? { trial, note: `All ${r.variantsTotal} variants count as trials of the campaign.` } : {}),
        next: `wait {kind:"OPTIMIZATION", ids:[${r.optimizationRunId}]}`,
      };
    }),
  );

  server.registerTool(
    'optimization_get',
    {
      title: 'Optimizer run status and leaderboard',
      description:
        'Status and progress; once ranked, the top-N of the leaderboard with robustness scores, guard flags, the plateau and Pareto diagnoses and WFE.',
      inputSchema: { runId: id, top: z.number().int().min(1).max(25).default(10) },
      annotations: READ_ONLY,
    },
    handle(async ({ runId, top }) => {
      await ctx.campaigns.guardOptimizationRead('optimization_get', runId);
      return optimizationSummary(ctx, runId, top);
    }),
  );

  server.registerTool(
    'optimization_promote',
    {
      title: 'Promote a variant',
      description:
        'Writes the variant as a new version of the source strategy and, when the run has an OOS window, launches the OOS backtest. Returns {promotedStrategyVersion, oosBacktestId}. Inside a campaign an OOS window in the locked region is refused — the holdout is spent only by campaign_finalize.',
      inputSchema: { runId: id, variantIdx: z.number().int().min(0) },
      // Moves the source strategy's current version to the variant (old versions stay) and may launch a backtest.
      annotations: DESTRUCTIVE,
    },
    handle(async ({ runId, variantIdx }) => {
      let campaign: Campaign | null = null;
      let sourceStrategyId: number | null = null;
      if (ctx.campaigns.active() || ctx.campaigns.requireCampaign) {
        const optimization = await ctx.api.getOptimization(runId);
        sourceStrategyId = optimization.sourceStrategyId;
        const { oosFrom, oosTo } = optimization.windowSpec;
        if (oosFrom && oosTo) {
          campaign = ctx.campaigns.guardLaunch({
            tool: 'optimization_promote',
            period: { from: oosFrom, to: oosTo },
            timeframe: optimization.timeframe,
            holdingBars: null,
          });
        }
        ctx.campaigns.guardRead(
          'optimization_promote',
          { from: optimization.windowSpec.optimizeFrom, to: optimization.windowSpec.optimizeTo },
          optimization.timeframe,
        );
      }
      const r = await ctx.api.promote(runId, variantIdx);
      let trial = null;
      if (campaign && r.oosBacktestId && sourceStrategyId !== null) {
        const version = await ctx.api.getStrategyVersion(sourceStrategyId, r.promotedStrategyVersion);
        trial = ctx.campaigns.record(campaign, {
          kind: 'BACKTEST',
          id: String(r.oosBacktestId),
          status: 'RUNNING',
          strategyId: sourceStrategyId,
          strategyVersion: r.promotedStrategyVersion,
          configHash: configHash(version.config),
          instrument: { symbol: null, timeframe: null, marketType: null },
          period: { from: '', to: '' },
          sharpe: null,
          return: null,
          maxDd: null,
          trades: null,
        });
      }
      return {
        promotedStrategyVersion: r.promotedStrategyVersion,
        oosBacktestId: r.oosBacktestId,
        ...(trial ? { trial } : {}),
        ...(r.oosBacktestId ? { next: `wait {kind:"BACKTEST", ids:[${r.oosBacktestId}]}` } : {}),
      };
    }),
  );
}

async function loadBaseConfig(ctx: ToolContext, request: Record<string, unknown>): Promise<unknown> {
  if (typeof request.strategyId === 'number') {
    return typeof request.strategyVersion === 'number'
      ? (await ctx.api.getStrategyVersion(request.strategyId, request.strategyVersion)).config
      : (await ctx.api.getStrategy(request.strategyId)).config;
  }
  return request.baseConfig ?? null;
}
