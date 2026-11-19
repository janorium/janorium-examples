import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hypothesesOf } from '../campaign/manager';
import { compactResearchReport } from '../summary/compact';
import { ADDITIVE, READ_ONLY } from './annotations';
import { researchJobSummary } from './builders';
import type { ToolContext } from './context';
import { handle } from './result';
import { body, id, marginMode, str } from './schemas';

/** Forward returns reach `max(horizons)` bars past a bar — the scan's own embargo. */
export function scanHorizonBars(request: Record<string, unknown>): number | null {
  const horizons = Array.isArray(request.horizons) ? request.horizons.filter((h): h is number => typeof h === 'number') : [];
  const excursion = typeof request.excursionHorizon === 'number' ? [request.excursionHorizon] : [];
  const all = [...horizons, ...excursion];
  return all.length > 0 ? Math.max(...all) : null;
}

function scanGuard(ctx: ToolContext, tool: string, request: Record<string, unknown>) {
  return ctx.campaigns.guardLaunch({
    tool,
    period: { from: str(request.from), to: str(request.to) },
    timeframe: str(request.timeframe),
    holdingBars: scanHorizonBars(request),
  });
}

export function registerResearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'research_scan',
    {
      title: 'Synchronous research scan',
      description:
        'POST /research/scan with a body per docs://research-scan-reference. Returns a ScanSummary: hypothesis counts (always quote them with any finding), admission counts, top findings with netDecileSpread, clusters, caveats. Bodies with validation or crossSymbol must use research_job_create. Inside a campaign its hypotheses count as trials.',
      inputSchema: { request: body.describe('ResearchScanRequest (docs://research-scan-reference).') },
      annotations: ADDITIVE,
    },
    handle(async ({ request }) => {
      const campaign = scanGuard(ctx, 'research_scan', request);
      const report = await ctx.api.researchScan(request);
      const summary = compactResearchReport(report);
      const trial = ctx.campaigns.record(campaign, {
        kind: 'RESEARCH',
        id: `scan-${report.runId ?? randomUUID()}`,
        status: 'DONE',
        strategyId: null,
        strategyVersion: null,
        configHash: null,
        instrument: { symbol: report.meta.symbol, timeframe: report.meta.timeframe, marketType: report.meta.marketType },
        period: { from: report.meta.from, to: report.meta.to },
        sharpe: null,
        return: null,
        maxDd: null,
        trades: null,
        hypotheses: hypothesesOf(report.meta as unknown as Record<string, unknown>),
      });
      return trial ? { ...summary, trial } : summary;
    }),
  );

  server.registerTool(
    'research_job_create',
    {
      title: 'Asynchronous research job',
      description:
        'POST /research/jobs — a scan with validation/crossSymbol, one engine scan per symbol × window. Returns {jobId}; then wait {kind:"RESEARCH_JOB"}.',
      inputSchema: { request: body.describe('ResearchScanRequest with validation (docs://research-scan-reference).') },
      annotations: ADDITIVE,
    },
    handle(async ({ request }) => {
      const campaign = scanGuard(ctx, 'research_job_create', request);
      const r = await ctx.api.createResearchJob(request);
      const trial = ctx.campaigns.record(campaign, {
        kind: 'RESEARCH',
        id: String(r.jobId),
        status: 'RUNNING',
        strategyId: null,
        strategyVersion: null,
        configHash: null,
        instrument: {
          symbol: str(request.symbol) || null,
          timeframe: str(request.timeframe) || null,
          marketType: str(request.marketType) || null,
        },
        period: { from: str(request.from), to: str(request.to) },
        sharpe: null,
        return: null,
        maxDd: null,
        trades: null,
        hypotheses: null,
      });
      return { jobId: r.jobId, status: r.status, tasksTotal: r.tasksTotal, ...(trial ? { trial } : {}), next: `wait {kind:"RESEARCH_JOB", ids:[${r.jobId}]}` };
    }),
  );

  server.registerTool(
    'research_job_get',
    {
      title: 'Research job status and report',
      description: 'Status and progress; once DONE, the same ScanSummary as research_scan for the run the job finished into.',
      inputSchema: { jobId: id, top: z.number().int().min(1).max(25).default(10) },
      annotations: READ_ONLY,
    },
    handle(async ({ jobId, top }) => {
      await ctx.campaigns.guardResearchJobRead('research_job_get', jobId);
      return researchJobSummary(ctx, jobId, top);
    }),
  );

  server.registerTool(
    'research_draft',
    {
      title: 'Strategy draft from a finding',
      description:
        'Builds a strategy config from a saved finding, addressed by coordinates (the server reads the numbers from its stored report). Returns {config, provenance, run, limitations}; validate and save it before running.',
      inputSchema: {
        runId: id,
        kind: z.enum(['EVENT', 'FEATURE', 'SLICE']),
        feature: z.string().optional(),
        horizon: z.number().int().positive(),
        slice: z.string().optional().describe('family:name, required for SLICE.'),
        target: z
          .object({ initialCapital: z.number().positive().optional(), leverage: z.number().int().optional(), marginMode: marginMode.optional() })
          .optional(),
      },
      // Builds a config from a stored report; the platform persists nothing.
      annotations: READ_ONLY,
    },
    handle(async ({ runId, ...request }) => {
      if (ctx.campaigns.active()) {
        const meta = (await ctx.api.getResearchRun(runId)).report.meta;
        ctx.campaigns.guardRead('research_draft', { from: meta.from, to: meta.to }, meta.timeframe);
      }
      return ctx.api.draftFinding(runId, request);
    }),
  );
}
