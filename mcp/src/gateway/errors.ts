/** An upstream message is quoted, not relayed whole: past this many characters it is cut (security audit, 2026-10-08). */
export const MAX_GATEWAY_MESSAGE_CHARS = 1000;

/**
 * A non-2xx answer from the gateway, carrying the platform's error envelope (`{status, error, message}`) so a tool can
 * hand the model the same code the REST contract documents. The message is upstream text — capped here, and marked as
 * untrusted where it is rendered (`tools/result.ts`).
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly method: string,
    readonly path: string,
    /** Seconds from `Retry-After`; `null` when the gateway did not say (every `RATE_LIMITED` today). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message.length > MAX_GATEWAY_MESSAGE_CHARS ? `${message.slice(0, MAX_GATEWAY_MESSAGE_CHARS)}…` : message);
    this.name = 'GatewayError';
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** The network failed before any status arrived — a different statement from any HTTP error. */
export class TransportError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`${method} ${path} did not complete: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 300)}`);
    this.name = 'TransportError';
  }
}

/**
 * A tool refusing a request on its own, before it reaches the gateway. `status` is set when the refusal has an HTTP
 * meaning the protocol names (`409 CAMPAIGN_FINALIZED`); `details` travels to the model beside the code.
 */
export class ToolInputError extends Error {
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ToolInputError';
    this.status = options.status;
    this.details = options.details;
  }
}
