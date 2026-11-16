import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DESTRUCTIVE, READ_ONLY } from './annotations';
import type { ToolContext } from './context';
import { handle } from './result';
import { id, instant } from './schemas';

export const MAX_FINALIZE_WAIT_SEC = 600;

/** The three tools of the campaign protocol. The rules themselves are in `CampaignManager`. */
export function registerCampaignTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'campaign_start',
    {
      title: 'Start a campaign (reserve the holdout)',
      description: [
        'Declares the period and reserves its tail as a holdout before anything is run. holdoutFrom must leave at least half of [from, to] in-sample.',
        'From then on every run and every read whose period reaches [holdoutFrom − embargo, to] is refused with HOLDOUT_LOCKED; embargo = max(maxHoldingBars, 24) bars.',
        'Every attempt becomes a ledger row (campaign://{id}/ledger); the holdout is run once, by campaign_finalize.',
        'A campaign over a period an earlier campaign already covered inherits its trial count; a holdout another campaign already spent is refused (HOLDOUT_SPENT).',
      ].join(' '),
      inputSchema: {
        name: z.string().min(1).max(120),
        strategyId: id.optional().describe('The strategy the campaign is about, for the ledger header.'),
        symbols: z.array(z.string()).min(1).max(30).describe('The holdout is run on symbols × timeframes (≤ 30); DSR uses the first pair.'),
        timeframes: z.array(z.string()).min(1).max(30),
        from: instant,
        to: instant,
        holdoutFrom: instant,
        parentCampaignId: z.string().optional().describe('Inherit the trial count of this campaign. Detected automatically when the periods overlap.'),
      },
      // Supersedes the active campaign, if any — that one can no longer be finalized.
      annotations: DESTRUCTIVE,
    },
    handle(async (input) => {
      const campaign = await ctx.campaigns.start(input);
      return {
        ...ctx.campaigns.ledger(campaign, 0),
        next: 'Run in-sample only: every period must end at or before locks[].lockedFrom. campaign_status shows the trial count; campaign_finalize runs the holdout once.',
      };
    }),
  );

  server.registerTool(
    'campaign_status',
    {
      title: 'Campaign ledger and lock',
      description:
        'The active (or named) campaign: locked region per timeframe, trials (m — the number the DSR is deflated by, inherited trials included), the Sharpe distribution of all attempts, the last rows, refusals, and the finalization once it exists. With strategyId (+ strategyVersion): whether that exact config is in the ledger and which robustness checks it still lacks.',
      inputSchema: { campaignId: z.string().optional(), strategyId: id.optional(), strategyVersion: z.number().int().positive().optional() },
      annotations: READ_ONLY,
    },
    handle(async ({ campaignId, strategyId, strategyVersion }) => ctx.campaigns.status(campaignId, strategyId ? { strategyId, strategyVersion } : undefined)),
  );

  server.registerTool(
    'campaign_finalize',
    {
      title: 'Finalize: the one holdout run',
      description: [
        'Spends the holdout, once. The candidate (a saved strategy version) must already be in the ledger and — unless the server runs with --no-robustness-gate — have a START_DATE_SHIFT batch, a randomizedEntry dry-run and a backtest_monte_carlo on this exact config (ROBUSTNESS_MISSING otherwise); no attempt may still be running (TRIALS_PENDING).',
        "Runs the holdout backtest over [holdoutFrom, to] on symbols × timeframes and an in-sample dry-run for the DSR inputs, then returns the holdout metrics and the Deflated Sharpe over the campaign's trial count.",
        'A second call answers 409 CAMPAIGN_FINALIZED. If the runs outlast timeoutSec the answer says RUNNING and campaign_status completes it.',
      ].join(' '),
      inputSchema: {
        campaignId: z.string().optional(),
        strategyId: id,
        strategyVersion: z.number().int().positive().optional().describe('Default: the current version.'),
        timeoutSec: z.number().int().min(1).max(MAX_FINALIZE_WAIT_SEC).default(MAX_FINALIZE_WAIT_SEC),
      },
      // Spends the holdout irreversibly.
      annotations: DESTRUCTIVE,
    },
    handle(async (input) => ctx.campaigns.finalize(input)),
  );
}
