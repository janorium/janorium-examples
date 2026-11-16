import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CoverageSummaryResponse } from '../platform-types';
import { READ_ONLY } from './annotations';
import type { ToolContext } from './context';
import { handle } from './result';
import { marketType } from './schemas';

export function coverageRows(response: CoverageSummaryResponse, symbol?: string, timeframe?: string, now = Date.now()) {
  return response.items
    .filter((item) => (!symbol || item.symbol === symbol) && (!timeframe || item.timeframe === timeframe))
    .map((item) => ({
      symbol: item.symbol,
      timeframe: item.timeframe,
      from: item.from,
      to: item.to,
      candles: item.count,
      stalenessHours: Math.round(((now - Date.parse(item.to)) / 3_600_000) * 10) / 10,
      ...(item.fundingCoverage ? { funding: { from: item.fundingCoverage.from, to: item.fundingCoverage.to } } : {}),
      ...(item.metricsCoverage ? { metrics: Object.keys(item.metricsCoverage) } : {}),
    }));
}

export function registerMarketTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'market_symbols',
    {
      title: 'Tradable symbols',
      description: 'Symbols the platform holds candles for, per market type.',
      inputSchema: { marketType, exchange: z.string().optional() },
      annotations: READ_ONLY,
    },
    handle(async ({ marketType, exchange }) => ctx.api.marketSymbols(exchange ?? ctx.config.exchange, marketType)),
  );

  server.registerTool(
    'market_coverage',
    {
      title: 'Candle coverage',
      description:
        'Per symbol × timeframe: first and last candle, count, hours since the last candle, funding and futures-metrics coverage. Check before choosing a period.',
      inputSchema: { marketType, symbol: z.string().optional(), timeframe: z.string().optional(), exchange: z.string().optional() },
      annotations: READ_ONLY,
    },
    handle(async ({ marketType, symbol, timeframe, exchange }) => {
      const response = await ctx.api.coverageSummary(exchange ?? ctx.config.exchange, marketType);
      return { exchange: response.exchange, marketType: response.marketType, items: coverageRows(response, symbol, timeframe) };
    }),
  );
}
