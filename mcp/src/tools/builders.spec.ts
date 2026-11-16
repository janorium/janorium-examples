import { ToolInputError } from '../gateway/errors';
import { backtestRow, backtestSummary, resolveRunTarget } from './builders';
import type { ToolContext } from './context';
import { pathFromMessage } from './strategy';

describe('backtest_get / backtestRow on a FAILED run', () => {
  const failed = {
    id: 97,
    status: 'FAILED',
    errorCode: 'MARKET_DATA_OUT_OF_ORDER',
    errorMessage: 'market.candles binance spot BTCUSDT 1d returned 2020-01-01T00:00:00Z after 2020-01-02T00:00:00Z',
    params: { symbol: 'BTCUSDT', timeframe: '1d', marketType: 'spot', from: '2020-01-01T00:00:00Z', to: '2026-10-13T00:00:00Z' },
    metrics: null,
  };
  const ctx = () => {
    const getBacktestSummary = jest.fn();
    const context = {
      api: { getBacktest: jest.fn().mockResolvedValue(failed), getBacktestSummary },
      campaigns: { observeBacktest: jest.fn(), trialOf: jest.fn().mockReturnValue(null) },
    } as unknown as ToolContext;
    return { context, getBacktestSummary };
  };

  // It used to say "Not finished yet — call wait", and an agent waited on a run that would never finish.
  it('says why it failed instead of "not finished yet", without re-running it', async () => {
    const { context, getBacktestSummary } = ctx();
    const result = await backtestSummary(context, 97);
    expect(result).toMatchObject({ backtestId: 97, status: 'FAILED', errorCode: 'MARKET_DATA_OUT_OF_ORDER', errorMessage: failed.errorMessage });
    expect(JSON.stringify(result)).not.toContain('Not finished yet');
    expect(getBacktestSummary).not.toHaveBeenCalled();
  });

  it('carries the code and message on the batch row too', async () => {
    const row = await backtestRow(ctx().context, 97);
    expect(row).toMatchObject({ status: 'FAILED', metrics: null, errorCode: 'MARKET_DATA_OUT_OF_ORDER', errorMessage: failed.errorMessage });
  });
});

describe('resolveRunTarget', () => {
  const futuresConfig = {
    market: { type: 'futures', exchange: 'binance', futures: { leverage: 5, marginMode: 'CROSS', applyFunding: false } },
    instrument: { symbol: 'ETHUSDT', timeframe: '15m' },
  };

  it('fills blanks from the config the way the editor does', () => {
    expect(resolveRunTarget(futuresConfig, { from: '2024-01-01', to: '2024-06-01' }, 'binance')).toEqual({
      exchange: 'binance',
      marketType: 'futures',
      symbol: 'ETHUSDT',
      timeframe: '15m',
      from: '2024-01-01T00:00:00Z',
      to: '2024-06-01T00:00:00Z',
      initialCapital: 10000,
      leverage: 5,
      marginMode: 'CROSS',
      applyFunding: false,
    });
  });

  it('lets the caller override, and sends no futures fields on spot', () => {
    const target = resolveRunTarget(
      futuresConfig,
      { marketType: 'spot', symbol: 'BTCUSDT', from: '2024-01-01T00:00:00Z', to: '2024-02-01T00:00:00Z', initialCapital: 500 },
      'binance',
    );
    expect(target).toMatchObject({ marketType: 'spot', symbol: 'BTCUSDT', timeframe: '15m', initialCapital: 500 });
    expect(target).not.toHaveProperty('leverage');
  });

  it('refuses when nothing names the instrument', () => {
    expect(() => resolveRunTarget({}, { from: '2024-01-01', to: '2024-02-01' }, 'binance')).toThrow(ToolInputError);
  });
});

describe('pathFromMessage', () => {
  it('extracts a config path when the message has one', () => {
    expect(pathFromMessage('entries[0].condition.all[1].right: must be a number')).toBe('entries[0].condition.all[1].right');
    expect(pathFromMessage("Unknown indicator 'FOO' at exit.signal.left")).toBe('exit.signal.left');
  });

  it('invents nothing', () => {
    expect(pathFromMessage('Config conflicts with itself')).toBeUndefined();
  });
});
