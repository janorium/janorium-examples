import { EventEmitter } from 'node:events';
import { silentLogger } from '../log';
import { NotificationHub, SUBSCRIBED_EVENTS, type SocketLike } from './notifications';

export class FakeSocket extends EventEmitter implements SocketLike {
  connected = true;
  disconnect() {
    this.connected = false;
  }
}

function hubWithSocket(capacity?: number) {
  const socket = new FakeSocket();
  const hub = new NotificationHub(() => socket, silentLogger, capacity);
  hub.start();
  return { hub, socket };
}

describe('NotificationHub', () => {
  it('subscribes to every terminal and progress event', () => {
    const { socket } = hubWithSocket();
    for (const event of SUBSCRIBED_EVENTS) {
      expect(socket.listenerCount(event)).toBe(1);
    }
    expect(SUBSCRIBED_EVENTS).toEqual(expect.arrayContaining(['dry-run.finished', 'research.finished', 'optimization.progress']));
    expect(SUBSCRIBED_EVENTS).not.toContain('research.job.finished');
  });

  it('records an event that arrived before anyone waited — the race a POST and a wait always have', async () => {
    const { hub, socket } = hubWithSocket();
    socket.emit('dry-run.finished', { dryRunId: 'abc', summary: { totalReturnPct: 1 } });
    await expect(hub.waitFor('DRY_RUN', 'abc', 10)).resolves.toMatchObject({ kind: 'DRY_RUN', id: 'abc', status: 'DONE' });
  });

  it('resolves a waiter when the event lands, and reports progress on the way', async () => {
    const { hub, socket } = hubWithSocket();
    const progress: (number | null)[] = [];
    const waiting = hub.waitFor('BACKTEST', 42, 1000, { onProgress: (p) => progress.push(p.pct) });
    socket.emit('backtest.progress', { backtestId: 42, pct: 50 });
    socket.emit('backtest.finished', { backtestId: 42, summary: {} });
    await expect(waiting).resolves.toMatchObject({ status: 'DONE', id: '42' });
    expect(progress).toEqual([50]);
  });

  it('treats a CANCELLED progress frame as terminal', async () => {
    const { hub, socket } = hubWithSocket();
    const waiting = hub.waitFor('RESEARCH_JOB', 7, 1000);
    socket.emit('research.progress', { jobId: 7, status: 'CANCELLED', pct: 30 });
    await expect(waiting).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('maps failures', () => {
    const { hub, socket } = hubWithSocket();
    socket.emit('optimization.failed', { optimizationRunId: 9, errorCode: 'X', message: 'boom' });
    expect(hub.result('OPTIMIZATION', 9)).toMatchObject({ status: 'FAILED', payload: { errorCode: 'X' } });
  });

  it('times out to null instead of rejecting', async () => {
    const { hub } = hubWithSocket();
    await expect(hub.waitFor('BACKTEST', 1, 5)).resolves.toBeNull();
  });

  it('can be aborted', async () => {
    const { hub } = hubWithSocket();
    const controller = new AbortController();
    const waiting = hub.waitFor('BACKTEST', 1, 10_000, { signal: controller.signal });
    controller.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('bounds the cache, evicting the oldest', () => {
    const { hub, socket } = hubWithSocket(2);
    ['a', 'b', 'c'].forEach((id) => socket.emit('dry-run.finished', { dryRunId: id }));
    expect(hub.result('DRY_RUN', 'a')).toBeUndefined();
    expect(hub.result('DRY_RUN', 'c')).toBeDefined();
  });

  it('ignores frames without an id', () => {
    const { hub, socket } = hubWithSocket();
    socket.emit('backtest.finished', { summary: {} });
    expect(hub.result('BACKTEST', 'undefined')).toBeUndefined();
  });
});

describe('NotificationHub reconnects after a server-side close', () => {
  class ReconnectingSocket extends FakeSocket {
    connect = jest.fn(() => {
      this.connected = true;
      this.emit('connect');
    });
  }

  const policy = { baseMs: 1000, maxMs: 4000, stableMs: 30_000, random: () => 1 };

  function setup() {
    const socket = new ReconnectingSocket();
    const hub = new NotificationHub(() => socket, silentLogger, 2000, policy);
    hub.start();
    socket.emit('connect');
    const serverClose = (code: string) => {
      socket.emit('error', { message: 'closed', code });
      socket.connected = false;
      socket.emit('disconnect', 'io server disconnect');
    };
    return { hub, socket, serverClose };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('backs off exponentially, capped, while the server keeps closing at once', () => {
    const { hub, socket, serverClose } = setup();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      serverClose('TOO_MANY_CONNECTIONS');
      expect(hub.lastServerClose?.code).toBe('TOO_MANY_CONNECTIONS');
      const before = socket.connect.mock.calls.length;
      let waited = 0;
      while (socket.connect.mock.calls.length === before) {
        jest.advanceTimersByTime(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 4000]);
    expect(hub.fatal).toBeNull();
    expect(hub.connected).toBe(true);
  });

  it('reconnects after a transient UNAUTHORIZED (auth briefly down at start-up)', () => {
    const { socket, serverClose } = setup();
    serverClose('UNAUTHORIZED');
    jest.advanceTimersByTime(1000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('stops for good on API_KEY_REVOKED and says why', () => {
    const { hub, socket, serverClose } = setup();
    serverClose('API_KEY_REVOKED');
    jest.advanceTimersByTime(120_000);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(hub.fatal).toMatchObject({ code: 'API_KEY_REVOKED' });
  });

  it('leaves a network drop to socket.io, and close() cancels a pending reconnect', () => {
    const { hub, socket, serverClose } = setup();
    socket.connected = false;
    socket.emit('disconnect', 'transport close');
    jest.advanceTimersByTime(120_000);
    expect(socket.connect).not.toHaveBeenCalled();

    socket.emit('connect');
    serverClose('TOO_MANY_CONNECTIONS');
    hub.close();
    jest.advanceTimersByTime(120_000);
    expect(socket.connect).not.toHaveBeenCalled();
  });
});
