import type { JobKind, NotificationHub, ProgressUpdate, TerminalEvent, TerminalStatus } from '../ws/notifications';

export interface JobOutcome {
  id: string;
  status: TerminalStatus | 'RUNNING';
  /** Present when the socket delivered the answer. */
  event?: TerminalEvent;
  /** `socket` or `poll` — which of the two sources settled it. */
  source?: 'socket' | 'poll';
}

/** Reads a persisted run's status over REST; `null` while it is still running. */
export type StatusPoller = (kind: JobKind, id: string) => Promise<TerminalStatus | null>;

export interface AwaitJobsDeps {
  hub: NotificationHub;
  poll: StatusPoller;
  pollIntervalMs: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Waits for each id until it finishes or the shared deadline passes.
 *
 * The socket is the fast path. For runs that persist a status row — backtests, optimizations, research jobs — a REST
 * poll runs beside it, because the socket delivers with no replay and a reconnect in the middle of a run drops the one
 * event that mattered. A dry-run has no row, so for it the socket (and the hub's record of what it already saw) is the
 * only source. Running out of time is an answer, `RUNNING`, not an error.
 */
export async function awaitJobs(
  deps: AwaitJobsDeps,
  kind: JobKind,
  ids: string[],
  timeoutMs: number,
  onProgress?: (update: ProgressUpdate) => void,
): Promise<JobOutcome[]> {
  const deadline = Date.now() + timeoutMs;
  return Promise.all(ids.map((id) => awaitOne(deps, kind, id, deadline, onProgress)));
}

async function awaitOne(deps: AwaitJobsDeps, kind: JobKind, id: string, deadline: number, onProgress?: (update: ProgressUpdate) => void): Promise<JobOutcome> {
  const controller = new AbortController();
  const fromSocket = deps.hub
    .waitFor(kind, id, Math.max(0, deadline - Date.now()), { onProgress, signal: controller.signal })
    .then((event): JobOutcome | null => (event ? { id, status: event.status, event, source: 'socket' } : null));

  if (kind === 'DRY_RUN') {
    return (await fromSocket) ?? { id, status: 'RUNNING' };
  }

  const fromPoll = (async (): Promise<JobOutcome | null> => {
    while (!controller.signal.aborted && Date.now() < deadline) {
      const status = await deps.poll(kind, id).catch(() => null);
      if (status) {
        return { id, status, event: deps.hub.result(kind, id), source: 'poll' };
      }
      await sleep(Math.min(deps.pollIntervalMs, Math.max(0, deadline - Date.now())), controller.signal);
    }
    return null;
  })();

  const first = await Promise.race([fromSocket, fromPoll]);
  const settled = first ?? (await Promise.all([fromSocket, fromPoll])).find((outcome) => outcome !== null) ?? null;
  controller.abort();
  return settled ?? { id, status: 'RUNNING' };
}
