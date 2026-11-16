import { GatewayError, ToolInputError, TransportError } from './errors';

export type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * A request body above this is refused before it is sent (security audit, 2026-10-08). The platform caps a strategy config
 * at 256 KiB (`413 CONFIG_TOO_LARGE`); the margin is the request around the config, so the platform's own code still
 * answers for a config near its limit. A real config is a few KB.
 */
export const MAX_REQUEST_BODY_BYTES = 272 * 1024;
/** A `429` whose `Retry-After` asks for longer than this is not waited out: the agent is told, and decides. */
export const MAX_RETRY_AFTER_SEC = 10;

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Default per-request ceiling. Long synchronous calls (the summary re-runs) pass their own. */
  timeoutMs?: number;
  /** Retries of a GET whose connection failed. Never applied to POST/PUT — see {@link GatewayClient.request}. */
  getRetries?: number;
  retryDelayMs?: number;
  /** Retries of a GET answered `429` — bounded, and only when the wait fits {@link MAX_RETRY_AFTER_SEC}. */
  rateLimitRetries?: number;
  /** Backoff of a `429` without `Retry-After`: this, then twice this. */
  rateLimitDelayMs?: number;
  maxBodyBytes?: number;
  /** Injected by tests; `setTimeout` otherwise. */
  sleep?: (ms: number) => Promise<void>;
  /** Read on every request — the campaign's `X-Campaign-Id` changes mid-process. */
  headers?: () => Record<string, string>;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /**
   * A POST with no side effect (validate, a synchronous dry-run summary, compare): a `429` proves nothing ran, so it is
   * backed off and repeated like a GET's. A dropped connection is still not retried — the work may have run.
   */
  idempotent?: boolean;
}

const IDEMPOTENT = new Set(['GET', 'HEAD']);

/**
 * The only way this package talks to the platform: the API gateway, under the key, like any other client.
 *
 * Rules of the tool contract and of the 2026-10-08 security audit, kept here rather than in each tool:
 * - a write is never retried, not even on a dropped connection or a `429`: a backtest that was accepted and whose
 *   answer was lost must not be launched twice. Its `429` becomes a {@link GatewayError} with `retryAfterSec`;
 * - a GET is retried when no status arrived at all; a GET or a side-effect-free POST ({@link RequestOptions.idempotent})
 *   answered `429` backs off — honouring `Retry-After` when it is short, giving up at once when it is long (a daily
 *   quota is not waited out). `ENGINE_BUSY`, `MONTE_CARLO_BUSY` and `TOO_MANY_CONCURRENT_RERUNS` clear in seconds;
 * - redirects are never followed: a `3xx` would carry the key to wherever `Location` points, so it is an error;
 * - a body over {@link MAX_REQUEST_BODY_BYTES} is refused before it leaves.
 */
export class GatewayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly retryDelayMs: number;
  private readonly rateLimitRetries: number;
  private readonly rateLimitDelayMs: number;
  private readonly maxBodyBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GatewayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.getRetries = options.getRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.rateLimitRetries = options.rateLimitRetries ?? 2;
    this.rateLimitDelayMs = options.rateLimitDelayMs ?? 1000;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  put<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  /** A write like `put`: never retried on a connection failure, backs off on `429` only when `idempotent` is passed. */
  patch<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (payload !== undefined && Buffer.byteLength(payload, 'utf8') > this.maxBodyBytes) {
      throw new ToolInputError(
        'REQUEST_TOO_LARGE',
        `The request body is ${Buffer.byteLength(payload, 'utf8')} bytes; this server sends at most ${this.maxBodyBytes}. Nothing was sent.`,
        { status: 413 },
      );
    }
    const idempotent = IDEMPOTENT.has(method);
    const backOffOn429 = idempotent || options.idempotent === true;
    let connectionRetries = 0;
    let rateLimitRetries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path, options.query), {
          method,
          headers: {
            ...(this.options.headers?.() ?? {}),
            Authorization: `Bearer ${this.options.apiKey}`,
            Accept: 'application/json',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        });
      } catch (error) {
        if (idempotent && connectionRetries < this.getRetries) {
          connectionRetries++;
          await this.sleep(this.retryDelayMs * connectionRetries);
          continue;
        }
        throw new TransportError(method, path, error);
      }
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        throw new GatewayError(
          response.status || 302,
          'REDIRECT_REFUSED',
          'The gateway answered with a redirect. It is not followed, so the API key never travels to another address; check CB_BASE_URL.',
          method,
          path,
        );
      }
      if (response.status === 429 && backOffOn429 && rateLimitRetries < this.rateLimitRetries) {
        const waitMs = this.rateLimitWait(response.headers.get('retry-after'), rateLimitRetries);
        if (waitMs !== null) {
          await response.body?.cancel().catch(() => undefined);
          rateLimitRetries++;
          await this.sleep(waitMs);
          continue;
        }
      }
      return this.read<T>(method, path, response);
    }
  }

  /** How long to back off before retrying a GET answered `429`; `null` when the gateway asks for longer than we wait. */
  private rateLimitWait(retryAfter: string | null, attempt: number): number | null {
    const seconds = retryAfterSeconds(retryAfter);
    if (seconds === null) {
      return this.rateLimitDelayMs * 2 ** attempt;
    }
    return seconds > MAX_RETRY_AFTER_SEC ? null : Math.max(seconds * 1000, 250);
  }

  private async read<T>(method: string, path: string, response: Response): Promise<T> {
    const text = await response.text();
    if (response.ok) {
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }
    let code = `HTTP_${response.status}`;
    let message = text.slice(0, 500) || response.statusText;
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error)) {
        code = body.error;
      }
      if (typeof body.message === 'string' && body.message) {
        message = body.message;
      }
    } catch {
      // Not the JSON envelope (a proxy page, an empty body) — the status code and raw text are all there is.
    }
    throw new GatewayError(response.status, code, message, method, path, retryAfterSeconds(response.headers.get('retry-after')));
  }

  private url(path: string, query?: Query): string {
    const url = new URL(this.options.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

/** `Retry-After` as seconds: delta-seconds or an HTTP-date; `null` when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
