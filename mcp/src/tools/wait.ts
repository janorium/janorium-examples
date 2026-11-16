import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolInputError } from '../gateway/errors';
import { awaitJobs, type JobOutcome, type StatusPoller } from '../jobs/wait';
import { safeCode, sanitizeText, untrusted } from '../output/untrusted';
import { fromDryRunEvent } from '../summary/run-summary';
import type { JobKind, ProgressUpdate } from '../ws/notifications';
import { backtestRow, backtestSummary, optimizationSummary, researchJobSummary } from './builders';
import { READ_ONLY } from './annotations';
import type { ToolContext } from './context';
import { handle } from './result';

export const MAX_WAIT_SEC = 600;

export function statusPoller(ctx: ToolContext): StatusPoller {
  return async (kind, id) => {
    const numericId = Number(id);
    switch (kind) {
      case 'BACKTEST': {
        const status = (await ctx.api.getBacktest(numericId)).status;
        return status === 'DONE' || status === 'FAILED' ? status : null;
      }
      case 'OPTIMIZATION': {
        const status = (await ctx.api.getOptimization(numericId)).status;
        return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED' ? status : null;
      }
      case 'RESEARCH_JOB': {
        const status = (await ctx.api.getResearchJob(numericId)).job.status;
        return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED' ? status : null;
      }
      default:
        return null;
    }
  };
}

/**
 * A failure as the event told it — or, with no event, as the persisted row tells it: the code if it looks like one, the
 * message as untrusted upstream text (security audit, 2026-10-08).
 */
function failure(outcome: JobOutcome, row?: { errorCode?: string | null; errorMessage?: string | null }) {
  const payload = outcome.event?.payload;
  const code = payload?.errorCode ?? row?.errorCode;
  const message: unknown = payload?.message ?? row?.errorMessage;
  return {
    id: outcome.id,
    status: outcome.status,
    errorCode: code === undefined || code === null ? null : safeCode(code, 'UNRECOGNIZED_ERROR_CODE'),
    message: typeof message === 'string' ? untrusted(message) : null,
  };
}

/**
 * A FAILED backtest the REST poll settled has no socket event, so its reason used to come back as
 * `{errorCode: null, message: null}` although `GET /backtests/{id}` carries both (correctness audit, 2026-10-16).
 * The row is read through `backtestRow`, which also records the outcome in the campaign ledger.
 */
async function failedBacktest(ctx: ToolContext, outcome: JobOutcome) {
  if (outcome.event) {
    return failure(outcome);
  }
  const row = await backtestRow(ctx, Number(outcome.id));
  return { ...failure(outcome, row), trial: row.trial, instrument: row.instrument, period: row.period };
}

/** Why a still-running id may never resolve: the socket closed for good (a revoked key), or is down for now. */
export function notificationsNote(ctx: ToolContext, kind: JobKind): { note?: string } {
  const fatal = ctx.hub.fatal;
  if (fatal) {
    return {
      note: `The notifications socket was closed by the server (${fatal.code}): this API key is no longer valid, so ${kind === 'DRY_RUN' ? 'this result will never arrive' : 'neither the socket nor REST polling can report it'}. Create a new key, put it in CB_API_KEY and restart the MCP server.`,
    };
  }
  if (kind === 'DRY_RUN' && !ctx.hub.connected) {
    const last = ctx.hub.lastServerClose;
    const why = last?.code ? ` (last closed by the server: ${last.code}; reconnecting with backoff)` : '';
    return { note: `The notifications socket is not connected${why}, so this result may never arrive; run the dry-run again if it does not.` };
  }
  return {};
}

/** Turns settled outcomes into the same answer the matching `*_get` tool gives. */
export async function describeOutcomes(ctx: ToolContext, kind: JobKind, outcomes: JobOutcome[]) {
  const running = (outcome: JobOutcome) => ({ id: outcome.id, status: 'RUNNING', ...notificationsNote(ctx, kind) });

  switch (kind) {
    case 'DRY_RUN':
      return outcomes.map((o) => {
        if (o.status !== 'RUNNING') {
          ctx.campaigns.completeDryRun(o.id, o.status, o.event?.payload);
        }
        if (o.status === 'DONE' && o.event) {
          const summary = fromDryRunEvent(o.event.payload, ctx.dryRuns.get(o.id));
          summary.trial = ctx.campaigns.trialOf('DRY_RUN', o.id);
          return summary;
        }
        return o.status === 'RUNNING' ? running(o) : failure(o);
      });
    case 'BACKTEST':
      if (outcomes.length === 1 && outcomes[0].status === 'DONE') {
        return [await backtestSummary(ctx, Number(outcomes[0].id))];
      }
      return Promise.all(
        outcomes.map(async (o) =>
          o.status === 'RUNNING' ? running(o) : o.status === 'DONE' ? await backtestRow(ctx, Number(o.id)) : await failedBacktest(ctx, o),
        ),
      );
    case 'OPTIMIZATION':
      return Promise.all(outcomes.map(async (o) => (o.status === 'RUNNING' ? running(o) : await optimizationSummary(ctx, Number(o.id), 10))));
    case 'RESEARCH_JOB':
      return Promise.all(outcomes.map(async (o) => (o.status === 'RUNNING' ? running(o) : await researchJobSummary(ctx, Number(o.id)))));
  }
}

/** Inside a campaign, waiting on a run is reading it: a run over the locked region is refused like any other read. */
async function guardWait(ctx: ToolContext, kind: JobKind, ids: string[]): Promise<void> {
  if (!ctx.campaigns.active()) {
    return;
  }
  for (const id of ids) {
    switch (kind) {
      case 'BACKTEST':
        await ctx.campaigns.guardBacktestRead('wait', [Number(id)]);
        break;
      case 'OPTIMIZATION':
        await ctx.campaigns.guardOptimizationRead('wait', Number(id));
        break;
      case 'RESEARCH_JOB':
        await ctx.campaigns.guardResearchJobRead('wait', Number(id));
        break;
      case 'DRY_RUN': {
        const launch = ctx.dryRuns.get(id);
        if (launch) {
          ctx.campaigns.guardRead('wait', { from: launch.from, to: launch.to }, launch.timeframe);
        } else if (!ctx.campaigns.rowOf('DRY_RUN', id)) {
          throw new ToolInputError(
            'HOLDOUT_UNVERIFIABLE',
            `Dry-run ${id} was not launched by this server, so its period is unknown and it cannot be checked against the campaign lock.`,
          );
        }
        break;
      }
    }
  }
}

export function registerWaitTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wait',
    {
      title: 'Wait for runs to finish',
      description: [
        `Blocks until every id finishes or timeoutSec (≤ ${MAX_WAIT_SEC}) passes; an id still going comes back as {status:"RUNNING"} — call wait again.`,
        'The result has the shape of the matching *_get tool: DRY_RUN → RunSummary; BACKTEST → RunSummary for one id, compact rows for several (then backtest_get the interesting one); OPTIMIZATION → optimization_get; RESEARCH_JOB → research_job_get.',
        'Progress is sent as MCP progress notifications when the client asks for them.',
      ].join(' '),
      inputSchema: {
        kind: z.enum(['DRY_RUN', 'BACKTEST', 'OPTIMIZATION', 'RESEARCH_JOB']),
        ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .max(30),
        timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(120),
      },
      annotations: READ_ONLY,
    },
    handle(async ({ kind, ids, timeoutSec }, extra) => {
      if (kind !== 'DRY_RUN') {
        // Polled over REST, so each id becomes a path segment: a positive integer or nothing.
        const bad = ids.find((value) => !/^[1-9]\d{0,15}$/.test(String(value)));
        if (bad !== undefined) {
          throw new ToolInputError('INVALID_ID', `${kind} ids are positive integers; got ${JSON.stringify(String(bad).slice(0, 40))}.`);
        }
      }
      await guardWait(ctx, kind, ids.map(String));
      const progressToken = extra._meta?.progressToken;
      const done = new Set<string>();
      const onProgress = (update: ProgressUpdate) => {
        if (progressToken === undefined) {
          return;
        }
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: update.pct ?? done.size,
              total: update.pct !== null ? 100 : ids.length,
              message: `${kind} ${sanitizeText(update.id, 40)}: ${update.pct !== null ? `${update.pct}%` : sanitizeText(String(update.payload.status ?? 'running'), 40)}`,
            },
          })
          .catch(() => undefined);
      };
      const outcomes = await awaitJobs(
        { hub: ctx.hub, poll: statusPoller(ctx), pollIntervalMs: ctx.config.pollIntervalMs },
        kind,
        ids.map(String),
        timeoutSec * 1000,
        onProgress,
      );
      outcomes.filter((o) => o.status !== 'RUNNING').forEach((o) => done.add(o.id));
      return { kind, results: await describeOutcomes(ctx, kind, outcomes) };
    }),
  );
}
