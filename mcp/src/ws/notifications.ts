import type { Logger } from '../log';

export type JobKind = 'DRY_RUN' | 'BACKTEST' | 'OPTIMIZATION' | 'RESEARCH_JOB';
export type TerminalStatus = 'DONE' | 'FAILED' | 'CANCELLED';

export interface TerminalEvent {
  kind: JobKind;
  id: string;
  status: TerminalStatus;
  event: string;
  payload: Record<string, any>;
  receivedAt: number;
}

export interface ProgressUpdate {
  kind: JobKind;
  id: string;
  pct: number | null;
  payload: Record<string, any>;
}

/** The part of a socket.io client this hub uses — narrow so tests can drive it with an EventEmitter. */
export interface SocketLike {
  connected: boolean;
  /** socket.io's `active`: `false` once the server refused or closed the socket — socket.io will not retry it alone. */
  active?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect?(): unknown;
  disconnect(): unknown;
}

/**
 * Reconnecting after the server closed the socket on purpose (the platform sends `error {code, message}` and
 * disconnects: UNAUTHORIZED, TOO_MANY_CONNECTIONS, API_KEY_REVOKED). socket.io retries a dropped network by itself, never
 * a server-side close, so the hub does it: exponential from `baseMs`, capped at `maxMs`, with jitter. The delay only
 * resets after a connection that lasted `stableMs` — a server that accepts and then closes at once (too many
 * connections) is not hammered.
 */
export interface ReconnectPolicy {
  baseMs: number;
  maxMs: number;
  stableMs: number;
  /** Injected by tests; `Math.random` otherwise. */
  random?: () => number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = { baseMs: 2_000, maxMs: 60_000, stableMs: 30_000 };

/** The close codes the platform sends; anything else in `code` is kept as `null`. */
const CLOSE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A key the server found revoked stays revoked: reconnecting with it is pointless, and tools must say so. */
export const FATAL_CLOSE_CODES = new Set(['API_KEY_REVOKED']);

export interface SocketClose {
  code: string | null;
  message: string;
  at: string;
}

interface Route {
  kind: JobKind;
  idField: string;
  terminal?: TerminalStatus;
}

/**
 * socket.io event → job. Event names are the platform's event names, unchanged.
 * A cancellation has no event of its own: it arrives as a progress frame whose `status`
 * is `CANCELLED`, which is why progress routes are inspected for it.
 */
const ROUTES: Record<string, Route> = {
  'dry-run.finished': { kind: 'DRY_RUN', idField: 'dryRunId', terminal: 'DONE' },
  'dry-run.failed': { kind: 'DRY_RUN', idField: 'dryRunId', terminal: 'FAILED' },
  'backtest.progress': { kind: 'BACKTEST', idField: 'backtestId' },
  'backtest.finished': { kind: 'BACKTEST', idField: 'backtestId', terminal: 'DONE' },
  'backtest.failed': { kind: 'BACKTEST', idField: 'backtestId', terminal: 'FAILED' },
  'optimization.progress': { kind: 'OPTIMIZATION', idField: 'optimizationRunId' },
  'optimization.finished': { kind: 'OPTIMIZATION', idField: 'optimizationRunId', terminal: 'DONE' },
  'optimization.failed': { kind: 'OPTIMIZATION', idField: 'optimizationRunId', terminal: 'FAILED' },
  'research.progress': { kind: 'RESEARCH_JOB', idField: 'jobId' },
  'research.finished': { kind: 'RESEARCH_JOB', idField: 'jobId', terminal: 'DONE' },
  'research.failed': { kind: 'RESEARCH_JOB', idField: 'jobId', terminal: 'FAILED' },
};

export const SUBSCRIBED_EVENTS = Object.keys(ROUTES);

interface Waiter {
  resolve: (event: TerminalEvent | null) => void;
  onProgress?: (update: ProgressUpdate) => void;
}

export interface WaitOptions {
  onProgress?: (update: ProgressUpdate) => void;
  signal?: AbortSignal;
}

/**
 * The one notifications socket this process holds.
 *
 * It connects at start-up and records **every** terminal event it sees, whether or not anyone is waiting yet. That is
 * not a convenience: the platform delivers events fire-and-forget with no replay, so an event that lands between a
 * `POST` returning and `wait` being called would otherwise be lost. It is also the dry-run cache — a dry-run's result
 * exists nowhere but in its event, so the record kept here, keyed by `dryRunId`, is the only copy.
 */
export class NotificationHub {
  private socket: SocketLike | null = null;
  private readonly results = new Map<string, TerminalEvent>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** The last `error {code, message}` the server sent before closing; cleared by the next connection. */
  private lastClose: SocketClose | null = null;
  /** Set once the server closed the socket for good (a revoked key): no reconnect, and tools say why. */
  private fatalClose: SocketClose | null = null;
  private connectedAt: number | null = null;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketFactory: () => SocketLike,
    private readonly log: Logger,
    private readonly capacity = 2000,
    private readonly reconnect: ReconnectPolicy = DEFAULT_RECONNECT,
  ) {}

  start(): void {
    if (this.socket) {
      return;
    }
    const socket = this.socketFactory();
    this.socket = socket;
    socket.on('connect', () => {
      this.connectedAt = Date.now();
      this.lastClose = null;
      this.log.info('notifications socket connected');
    });
    socket.on('disconnect', (reason: unknown) => {
      const lasted = this.connectedAt === null ? 0 : Date.now() - this.connectedAt;
      this.connectedAt = null;
      if (lasted >= this.reconnect.stableMs) {
        this.retries = 0;
      }
      const why = this.lastClose ? ` (${this.lastClose.code ?? this.lastClose.message})` : '';
      this.log.warn(`notifications socket disconnected: ${String(reason)}${why}`);
      if (reason === 'io server disconnect') {
        this.afterServerClose(socket);
      }
    });
    socket.on('connect_error', (error: Error) => {
      this.log.warn(`notifications socket could not connect: ${error?.message ?? String(error)}`);
      // A refusal by the server's middleware leaves the socket inactive; socket.io does not retry that one either.
      if (socket.active === false) {
        this.afterServerClose(socket);
      }
    });
    socket.on('error', (error: { message?: unknown; code?: unknown } | undefined) => {
      const code = typeof error?.code === 'string' && CLOSE_CODE.test(error.code) ? error.code : null;
      const message = (typeof error?.message === 'string' ? error.message : JSON.stringify(error ?? null)).slice(0, 200);
      this.lastClose = { code, message, at: new Date().toISOString() };
      this.log.warn(`notifications socket error: ${code ?? ''} ${message}`);
    });
    for (const event of SUBSCRIBED_EVENTS) {
      socket.on(event, (payload: Record<string, any>) => this.accept(event, payload));
    }
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Why the socket was closed for good (`API_KEY_REVOKED`), or `null` while it is up or still reconnecting. */
  get fatal(): SocketClose | null {
    return this.fatalClose;
  }

  /** The last close the server explained, while not connected — for a tool to say why results may be late. */
  get lastServerClose(): SocketClose | null {
    return this.connected ? null : this.lastClose;
  }

  private afterServerClose(socket: SocketLike): void {
    if (this.socket !== socket || this.retryTimer) {
      return; // closed by us, or a reconnect is already scheduled
    }
    if (this.lastClose?.code && FATAL_CLOSE_CODES.has(this.lastClose.code)) {
      this.fatalClose = this.lastClose;
      this.log.error(
        `notifications socket closed by the server: ${this.lastClose.code}. Not reconnecting — create a new API key, put it in CB_API_KEY and restart the MCP server.`,
      );
      return;
    }
    const ceiling = Math.min(this.reconnect.maxMs, this.reconnect.baseMs * 2 ** this.retries);
    const delay = Math.round(ceiling / 2 + (this.reconnect.random ?? Math.random)() * (ceiling / 2));
    this.retries = Math.min(this.retries + 1, 30);
    this.log.warn(`notifications socket: reconnecting in ${Math.round(delay / 100) / 10} s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.socket === socket) {
        socket.connect?.();
      }
    }, delay);
    this.retryTimer.unref?.();
  }

  close(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.disconnect();
    this.socket = null;
    for (const [key, waiters] of this.waiters) {
      waiters.forEach((waiter) => waiter.resolve(null));
      this.waiters.delete(key);
    }
  }

  /** Public for tests; in production the socket calls it. */
  accept(event: string, payload: Record<string, any>): void {
    const route = ROUTES[event];
    if (!route || !payload || payload[route.idField] === undefined || payload[route.idField] === null) {
      return;
    }
    const id = String(payload[route.idField]);
    const key = keyOf(route.kind, id);
    const status = route.terminal ?? (payload.status === 'CANCELLED' ? 'CANCELLED' : undefined);
    if (!status) {
      const pct = typeof payload.pct === 'number' ? payload.pct : null;
      this.waiters.get(key)?.forEach((waiter) => waiter.onProgress?.({ kind: route.kind, id, pct, payload }));
      return;
    }
    const terminal: TerminalEvent = { kind: route.kind, id, status, event, payload, receivedAt: Date.now() };
    this.results.delete(key);
    this.results.set(key, terminal);
    while (this.results.size > this.capacity) {
      const oldest = this.results.keys().next().value as string;
      this.results.delete(oldest);
    }
    const waiters = this.waiters.get(key);
    if (waiters) {
      this.waiters.delete(key);
      waiters.forEach((waiter) => waiter.resolve(terminal));
    }
  }

  result(kind: JobKind, id: string | number): TerminalEvent | undefined {
    return this.results.get(keyOf(kind, String(id)));
  }

  /** Resolves with the terminal event, or `null` on timeout or abort. Never rejects. */
  waitFor(kind: JobKind, id: string | number, timeoutMs: number, options: WaitOptions = {}): Promise<TerminalEvent | null> {
    const known = this.result(kind, id);
    if (known) {
      return Promise.resolve(known);
    }
    const key = keyOf(kind, String(id));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined = undefined;
      const waiter: Waiter = {
        onProgress: options.onProgress,
        resolve: (event) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(event);
        },
      };
      const detach = () => {
        const set = this.waiters.get(key);
        set?.delete(waiter);
        if (set && set.size === 0) {
          this.waiters.delete(key);
        }
      };
      const onAbort = () => {
        detach();
        waiter.resolve(null);
      };
      timer = setTimeout(onAbort, Math.max(0, timeoutMs));
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.waiters.has(key)) {
        this.waiters.set(key, new Set());
      }
      this.waiters.get(key)!.add(waiter);
    });
  }
}

function keyOf(kind: JobKind, id: string): string {
  return `${kind}:${id}`;
}
