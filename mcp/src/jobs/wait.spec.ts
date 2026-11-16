import { EventEmitter } from 'node:events';
import { silentLogger } from '../log';
import { NotificationHub, type SocketLike } from '../ws/notifications';
import { awaitJobs } from './wait';

class FakeSocket extends EventEmitter implements SocketLike {
  connected = true;
  disconnect() {
    this.connected = false;
  }
}

function setup() {
  const socket = new FakeSocket();
  const hub = new NotificationHub(() => socket, silentLogger);
  hub.start();
  return { hub, socket };
}

describe('awaitJobs', () => {
  it('settles from the socket', async () => {
    const { hub, socket } = setup();
    const poll = jest.fn().mockResolvedValue(null);
    const waiting = awaitJobs({ hub, poll, pollIntervalMs: 1000 }, 'BACKTEST', ['1'], 2000);
    setTimeout(() => socket.emit('backtest.finished', { backtestId: 1 }), 5);
    await expect(waiting).resolves.toEqual([expect.objectContaining({ id: '1', status: 'DONE', source: 'socket' })]);
  });

  it('falls back to REST when the socket stays silent', async () => {
    const { hub } = setup();
    const poll = jest.fn().mockResolvedValueOnce(null).mockResolvedValue('DONE');
    const outcomes = await awaitJobs({ hub, poll, pollIntervalMs: 5 }, 'OPTIMIZATION', ['9'], 2000);
    expect(outcomes).toEqual([expect.objectContaining({ id: '9', status: 'DONE', source: 'poll' })]);
    expect(poll).toHaveBeenCalledWith('OPTIMIZATION', '9');
  });

  it('never polls for a dry-run, and answers RUNNING on timeout', async () => {
    const { hub } = setup();
    const poll = jest.fn();
    await expect(awaitJobs({ hub, poll, pollIntervalMs: 1 }, 'DRY_RUN', ['x'], 10)).resolves.toEqual([{ id: 'x', status: 'RUNNING' }]);
    expect(poll).not.toHaveBeenCalled();
  });

  it('answers RUNNING when neither source finishes in time', async () => {
    const { hub } = setup();
    const poll = jest.fn().mockResolvedValue(null);
    await expect(awaitJobs({ hub, poll, pollIntervalMs: 5 }, 'BACKTEST', ['1'], 30)).resolves.toEqual([{ id: '1', status: 'RUNNING' }]);
  });

  it('survives a failing poll', async () => {
    const { hub, socket } = setup();
    const poll = jest.fn().mockRejectedValue(new Error('502'));
    const waiting = awaitJobs({ hub, poll, pollIntervalMs: 2 }, 'RESEARCH_JOB', ['3'], 2000);
    setTimeout(() => socket.emit('research.failed', { jobId: 3, errorCode: 'E' }), 10);
    await expect(waiting).resolves.toEqual([expect.objectContaining({ status: 'FAILED' })]);
  });

  it('waits for several ids under one deadline', async () => {
    const { hub, socket } = setup();
    socket.emit('backtest.finished', { backtestId: 1 });
    const poll = jest.fn().mockImplementation((_kind: string, id: string) => Promise.resolve(id === '2' ? 'FAILED' : null));
    const outcomes = await awaitJobs({ hub, poll, pollIntervalMs: 5 }, 'BACKTEST', ['1', '2', '3'], 40);
    expect(outcomes.map((o) => o.status)).toEqual(['DONE', 'FAILED', 'RUNNING']);
  });
});
