import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/*
 * The three prompts are part of the contract, not documentation: they fix the order
 * in which evidence is gathered, so that "it looked good once" is never the last step. The rules that
 * matter — the holdout lock, the trial count, one finalize, the robustness gate — are enforced by the server
 * (`campaign/manager.ts`); the prompt only says what order to meet them in, and what the refusals mean.
 */

export function iterateStrategyText(args: { strategyId?: string; symbol?: string; timeframe?: string; from?: string; to?: string; goal?: string }): string {
  const target = [args.symbol, args.timeframe, args.from && args.to ? `${args.from} → ${args.to}` : undefined].filter(Boolean).join(', ');
  return `You are iterating a trading strategy on Janorium (janorium.com) through its MCP tools.
${args.strategyId ? `Strategy: #${args.strategyId}.` : 'Start from a template (catalog://templates) or an existing strategy.'}${target ? ` Target: ${target}.` : ''}${args.goal ? ` Goal: ${args.goal}.` : ''}

This work runs as a campaign. The server enforces its rules; this list is the order to meet them in. Do not skip ahead.
1. Read docs://strategy-config-reference before writing or editing any config. Check market://coverage for the period.
2. campaign_start {name, symbols, timeframes, from, to, holdoutFrom} before running anything. Put holdoutFrom about two thirds into the period (it must be at least half-way). Tell the user the holdout boundary and the locks[].lockedFrom it returns: every period you run from now on ends at or before lockedFrom.
3. strategy_validate the config; fix every error it names. strategy_save it.
4. strategy_dry_run on the in-sample period. Read metrics, byExitReason, inertFeatures and verification — an inert feature means the config did not run the way it reads.
5. For the layer with the lowest openedBars / firedBars (or the fewest openedBars), call backtest_run for that period, wait, then backtest_near_miss. Change ONE thing, aimed at the condition with the highest blockingPct, or at the dominant blockedBy outcome if the rule is not what limits entries.
6. Robustness, on the exact saved version you would finalize (the server matches it by config hash): backtest_run with batch START_DATE_SHIFT (shifts ≥ 4) and a SYMBOL_MATRIX over 3+ related symbols; backtest_monte_carlo (BOOTSTRAP) on one of its backtests; strategy_dry_run with randomizedEntry. A result that does not beat randomized entries is not an edge. campaign_finalize refuses with ROBUSTNESS_MISSING until all three exist.
7. Only then optimization_create (read docs://optimizer-run-reference and use the plan_optimization prompt); its windows, OOS slice included, end before lockedFrom. Every variant is a trial. Promote at most one, and repeat step 6 on the promoted version.
8. Do not keep your own tally: every run is already a ledger row. campaign_status gives trials (m) — the count the Deflated Sharpe is corrected for — and the Sharpe distribution of all attempts. The best of m attempts is expected to look good by chance.
9. campaign_finalize {strategyId, strategyVersion} — once. It runs the holdout and returns the holdout metrics and dsr. Report them as they came out, beside the in-sample numbers and m. A dsr below 0.95 is not evidence of an edge, and a holdout worse than in-sample is the answer, not a reason to try again.

What the refusals mean — none of them is an obstacle to route around:
- HOLDOUT_LOCKED: the period reaches the holdout or its embargo. Shorten the period; do not look for another tool that reads it.
- NO_CAMPAIGN: this server runs nothing outside a campaign. Start one.
- campaignNotice on an answer: you are searching without a campaign. Start one (step 2) before you go on.
- ROBUSTNESS_MISSING / TRIALS_PENDING / CANDIDATE_NOT_IN_LEDGER: finish what it names, then finalize.
- CAMPAIGN_FINALIZED (409) / HOLDOUT_SPENT: that holdout has been looked at. A new campaign needs a later holdout, and it inherits the trial count of the period it reuses — starting over does not reset m.

Rules: quote numbers exactly as the tools return them; never compute your own metrics. If a tool returns retryAfterSec, wait that long — never loop on a rate limit. A result with caveats must be reported with its caveats. Visibility is the user's decision: a saved strategy stays PRIVATE, and strategy_set_visibility is called only when the user asked for it in so many words — never as a step of this loop.`;
}

export function readResearchReportText(args: { runId?: string }): string {
  return `You are reading a research scan report from Janorium${args.runId ? ` (run #${args.runId})` : ''}.
Read docs://research-scan-reference first.

How to read it:
- Every finding list is only meaningful with its denominator. Always state meta.featureHypotheses (and eventHypotheses / sliceHypotheses where used) next to any count of findings.
- Say meta.effectiveFindings, not the number of rows: rows in the same cluster are views of one effect.
- features.byAdmission: ADMITTED cleared the q-value, the net decile spread and the independence gate. Q_ABOVE_THRESHOLD, NET_SPREAD_NOT_POSITIVE and TOO_FEW_INDEPENDENT_ROWS each name the step a finding fell at; SPREAD_NOT_MEASURED means it was never priced — not that it is worthless.
- Never quote an IC without netDecileSpread beside it. An IC is scale-free; only the spread after costs can be compared to money.
- meta.expectedSelectionBias is a ceiling on how much the best of many tests overstates itself — mention it whenever you mention the top finding.
- A holdout that kept the sign is necessary, not sufficient.
- Caveats (IN_SAMPLE, SINGLE_INSTRUMENT, OVERLAPPING_WINDOWS, …) are part of the result: repeat them.
Only then, if something is admitted, use research_draft to turn it into a config — and validate it through iterate_strategy, not by trusting the scan.`;
}

export function planOptimizationText(args: { strategyId?: string }): string {
  return `You are planning an optimizer run${args.strategyId ? ` for strategy #${args.strategyId}` : ''} on Janorium.
Read docs://optimizer-run-reference first; this is a checklist, not a substitute.

- One idea per run: at most 4 search dimensions. Every extra dimension multiplies variants and the chance that the winner is noise; the complexity penalty exists for this.
- Choose ranges around values that already made sense in dry-runs, not the widest the schema allows. Declare mutually exclusive facets (e.g. a stop type and its parameter) so impossible combinations are not sampled.
- Windows: respect the minimums the reference gives for the timeframe (train length, test length, number of windows). Keep an out-of-sample tail (oosFrom/oosTo) that no window touches.
- Read the result through optimization_get: robustnessScore, guardFlags (DEGRADATION, LOW_TRADES), discardedByReason, wfe.
- diagnosis PLATEAU means many neighbouring variants perform alike — a stable region, which is what you want; a single spike surrounded by poor variants is overfitting. INSUFFICIENT_DATA is not NONE.
- paretoDiagnosis DEGENERATE means the front is one ray: return and drawdown trade off by leverage only.
- Promote at most one variant (optimization_promote), then judge it only by its OOS backtest, reported next to the number of variants tried.`;
}

export function registerPrompts(server: McpServer): void {
  const text = (value: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: value } }] });

  server.registerPrompt(
    'iterate_strategy',
    {
      title: 'Iterate a strategy',
      description:
        'The evidence-first loop: validate → dry-run → near-miss → one change → robustness (date shifts, symbol matrix, Monte Carlo, randomized entry) → only then optimise → one holdout run.',
      argsSchema: {
        strategyId: z.string().optional(),
        symbol: z.string().optional(),
        timeframe: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        goal: z.string().optional(),
      },
    },
    (args) => text(iterateStrategyText(args)),
  );

  server.registerPrompt(
    'read_research_report',
    {
      title: 'Read a research report',
      description: 'How to read admitted/rejected findings, hypothesis counts, effectiveFindings and netSpread without overstating them.',
      argsSchema: { runId: z.string().optional() },
    },
    (args) => text(readResearchReportText(args)),
  );

  server.registerPrompt(
    'plan_optimization',
    {
      title: 'Plan an optimizer run',
      description: 'How to declare a search space (≤ 4 dimensions, mutex facets), windows and OOS, and what PLATEAU means.',
      argsSchema: { strategyId: z.string().optional() },
    },
    (args) => text(planOptimizationText(args)),
  );
}
