import type {
  Backtest,
  BacktestNearMiss,
  BacktestSignals,
  CompareResponse,
  CoverageSummaryResponse,
  CreateBacktestBatchResponse,
  CreateBacktestRequest,
  CreateOptimizationResponse,
  CreateResearchJobResponse,
  CreateStrategyRequest,
  DryRunRequest,
  DryRunResponse,
  FindingDraftRequest,
  FindingDraftResponse,
  IndicatorCatalogItem,
  MarketSymbolsResponse,
  MarketType,
  MonteCarlo,
  Optimization,
  OptimizationLeaderboardResponse,
  Page,
  PromoteVariantResponse,
  ResearchJobDetail,
  ResearchReport,
  ResearchRunDetail,
  RiskScaling,
  Strategy,
  StrategyTemplate,
  StrategyVersionDetail,
  StrategyVersionSummary,
  Trade,
} from '../platform-types';
import type { RunSummaryDocument } from '../summary/document';
import type { GatewayClient } from './client';
import { ToolInputError } from './errors';

/**
 * A path segment from an id. Ids reach here from the model and from ledger files on disk, and a string such as
 * `../auth/keys` would otherwise become a different gateway route under the key — so only a safe integer passes.
 */
export function seg(value: number, min = 1): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new ToolInputError('INVALID_ID', `Not a platform id: ${JSON.stringify(String(value).slice(0, 40))}. Ids are positive integers.`);
  }
  return String(value);
}

/**
 * A synchronous run: the summary routes re-run the simulation before answering,
 * which on a multi-year low-timeframe period takes minutes, not seconds. The gateway and the proxies allow ten.
 */
const RERUN_TIMEOUT_MS = 10 * 60_000;
/** A synchronous research scan holds an engine permit for tens of seconds on a long period. */
const SCAN_TIMEOUT_MS = 5 * 60_000;

/** Typed endpoints of the gateway — one method per REST route the tools use, nothing else. */
export class PlatformApi {
  constructor(private readonly http: GatewayClient) {}

  /* ── strategies ── */

  listTemplates(): Promise<StrategyTemplate[]> {
    return this.http.get('/strategies/templates');
  }

  listIndicators(): Promise<IndicatorCatalogItem[]> {
    return this.http.get('/strategies/indicators');
  }

  getStrategy(id: number): Promise<Strategy> {
    return this.http.get(`/strategies/${seg(id)}`);
  }

  listStrategyVersions(id: number): Promise<StrategyVersionSummary[]> {
    return this.http.get(`/strategies/${seg(id)}/versions`);
  }

  getStrategyVersion(id: number, version: number): Promise<StrategyVersionDetail> {
    return this.http.get(`/strategies/${seg(id)}/versions/${seg(version)}`);
  }

  createStrategy(request: CreateStrategyRequest): Promise<{ id: number; name: string; createdAt: string }> {
    return this.http.post('/strategies', request);
  }

  /** `PUT` never changes `visibility` — that is {@link setStrategyVisibility}. */
  updateStrategy(id: number, request: Omit<CreateStrategyRequest, 'visibility'>): Promise<Strategy> {
    return this.http.put(`/strategies/${seg(id)}`, request);
  }

  /** Owner-only; needs the `publish` key scope, otherwise `403 SCOPE_MISSING`. */
  setStrategyVisibility(id: number, visibility: 'PUBLIC' | 'PRIVATE'): Promise<Strategy> {
    return this.http.patch(`/strategies/${seg(id)}/visibility`, { visibility });
  }

  /** `204` when valid; `422 INVALID_STRATEGY_CONFIG` / `400 CONFIG_CONFLICT` thrown as a GatewayError otherwise. */
  validateStrategy(config: unknown): Promise<void> {
    return this.http.post('/strategies/validate', config, { idempotent: true });
  }

  dryRun(request: DryRunRequest): Promise<DryRunResponse> {
    return this.http.post('/strategies/dry-run', request);
  }

  dryRunSummary(request: DryRunRequest): Promise<RunSummaryDocument> {
    return this.http.post('/strategies/dry-run/summary', request, { timeoutMs: RERUN_TIMEOUT_MS, idempotent: true });
  }

  /* ── backtests ── */

  createBacktests(request: CreateBacktestRequest): Promise<CreateBacktestBatchResponse> {
    return this.http.post('/backtests', request);
  }

  getBacktest(id: number): Promise<Backtest> {
    return this.http.get(`/backtests/${seg(id)}`);
  }

  getBacktestSummary(id: number): Promise<RunSummaryDocument> {
    return this.http.get(`/backtests/${seg(id)}/summary`, { timeoutMs: RERUN_TIMEOUT_MS });
  }

  getTrades(id: number, page: number, size: number): Promise<Page<Trade>> {
    return this.http.get(`/backtests/${seg(id)}/trades`, { query: { page, size } });
  }

  nearMiss(id: number, layer?: string, tolerance?: number): Promise<BacktestNearMiss> {
    return this.http.get(`/backtests/${seg(id)}/near-miss`, { query: { layer, tolerance }, timeoutMs: RERUN_TIMEOUT_MS });
  }

  signals(id: number, from: string, to: string, layer?: string): Promise<BacktestSignals> {
    return this.http.get(`/backtests/${seg(id)}/signals`, { query: { from, to, layer }, timeoutMs: RERUN_TIMEOUT_MS });
  }

  monteCarlo(id: number, query: { runs?: number; method?: string; ruinPct?: number; seed?: number }): Promise<MonteCarlo> {
    return this.http.get(`/backtests/${seg(id)}/monte-carlo`, { query });
  }

  riskScaling(id: number, targetDrawdownPct: number): Promise<RiskScaling> {
    return this.http.get(`/backtests/${seg(id)}/risk-scaling`, { query: { targetDrawdownPct } });
  }

  compare(ids: number[]): Promise<CompareResponse> {
    return this.http.post('/backtests/compare', { ids }, { idempotent: true });
  }

  /* ── optimizer ── */

  createOptimization(body: Record<string, unknown>): Promise<CreateOptimizationResponse> {
    return this.http.post('/optimizations', body);
  }

  getOptimization(id: number): Promise<Optimization> {
    return this.http.get(`/optimizations/${seg(id)}`);
  }

  leaderboard(id: number, limit: number): Promise<OptimizationLeaderboardResponse> {
    return this.http.get(`/optimizations/${seg(id)}/leaderboard`, { query: { limit, offset: 0 } });
  }

  promote(id: number, variantIdx: number): Promise<PromoteVariantResponse> {
    return this.http.post(`/optimizations/${seg(id)}/variants/${seg(variantIdx, 0)}/promote`, {});
  }

  /* ── research ── */

  researchScan(body: Record<string, unknown>): Promise<ResearchReport> {
    return this.http.post('/research/scan', body, { timeoutMs: SCAN_TIMEOUT_MS });
  }

  createResearchJob(body: Record<string, unknown>): Promise<CreateResearchJobResponse> {
    return this.http.post('/research/jobs', body);
  }

  getResearchJob(id: number): Promise<ResearchJobDetail> {
    return this.http.get(`/research/jobs/${seg(id)}`);
  }

  getResearchRun(id: number): Promise<ResearchRunDetail> {
    return this.http.get(`/research/runs/${seg(id)}`);
  }

  draftFinding(runId: number, request: FindingDraftRequest): Promise<FindingDraftResponse> {
    return this.http.post(`/research/runs/${seg(runId)}/findings/draft`, request);
  }

  /* ── market data ── */

  marketSymbols(exchange: string, marketType: MarketType): Promise<MarketSymbolsResponse> {
    return this.http.get('/market/symbols', { query: { exchange, marketType } });
  }

  coverageSummary(exchange: string, marketType: MarketType): Promise<CoverageSummaryResponse> {
    return this.http.get('/market/coverage-summary', { query: { exchange, marketType } });
  }
}
