import type { JobOutcome } from '../jobs/wait';
import type { ToolContext } from './context';
import { describeOutcomes } from './wait';

describe('describeOutcomes on a FAILED backtest', () => {
  const failed = {
    id: 97,
    status: 'FAILED',
    errorCode: 'NO_CANDLES',
    errorMessage: 'No candles available for BTCUSDT 1h in requested period',
    params: { symbol: 'BTCUSDT', timeframe: '1h', marketType: 'spot', from: '2024-01-01T00:00:00Z', to: '2024-02-01T00:00:00Z' },
    metrics: null,
  };
  const ctx = () => {
    const getBacktest = jest.fn().mockResolvedValue(failed);
    const observeBacktest = jest.fn();
    const context = {
      api: { getBacktest },
      campaigns: { observeBacktest, trialOf: jest.fn().mockReturnValue(null) },
      hub: { fatal: null, connected: true },
    } as unknown as ToolContext;
    return { context, getBacktest, observeBacktest };
  };

  it('reads the reason off the row when the REST poll settled it and no event arrived', async () => {
    const { context, observeBacktest } = ctx();
    const outcome: JobOutcome = { id: '97', status: 'FAILED', source: 'poll' };
    const [result] = await describeOutcomes(context, 'BACKTEST', [outcome]);
    expect(result).toMatchObject({
      id: '97',
      status: 'FAILED',
      errorCode: 'NO_CANDLES',
      message: '«untrusted:No candles available for BTCUSDT 1h in requested period»',
      instrument: { symbol: 'BTCUSDT', timeframe: '1h', marketType: 'spot' },
      period: { from: '2024-01-01T00:00:00Z', to: '2024-02-01T00:00:00Z' },
    });
    // The ledger learns the outcome the same way a DONE row does.
    expect(observeBacktest).toHaveBeenCalledWith(failed);
  });

  it('keeps the socket event as the source when there is one', async () => {
    const { context, getBacktest } = ctx();
    const outcome: JobOutcome = {
      id: '97',
      status: 'FAILED',
      source: 'socket',
      event: {
        kind: 'BACKTEST',
        id: '97',
        status: 'FAILED',
        event: 'backtest.failed',
        payload: { backtestId: 97, errorCode: 'INTERNAL_ERROR', message: 'boom' },
        receivedAt: 0,
      },
    };
    const [result] = await describeOutcomes(context, 'BACKTEST', [outcome]);
    expect(result).toMatchObject({ id: '97', status: 'FAILED', errorCode: 'INTERNAL_ERROR', message: '«untrusted:boom»' });
    expect(getBacktest).not.toHaveBeenCalled();
  });

  it('answers null, not a made-up code, when the row carries no reason either', async () => {
    const { context, getBacktest } = ctx();
    getBacktest.mockResolvedValue({ ...failed, errorCode: null, errorMessage: null });
    const [result] = await describeOutcomes(context, 'BACKTEST', [{ id: '97', status: 'FAILED', source: 'poll' }]);
    expect(result).toMatchObject({ status: 'FAILED', errorCode: null, message: null });
  });
});
