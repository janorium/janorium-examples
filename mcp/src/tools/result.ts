import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GatewayError, ToolInputError, TransportError } from '../gateway/errors';
import { mask, stderrLogger, type Logger } from '../log';
import { fitResponse } from '../output/limit';
import { sanitizeText, untrusted } from '../output/untrusted';

/**
 * Where an unexpected failure is written. stderr, never stdout (stdout is the JSON-RPC stream); `createServer` points it
 * at the server's own logger.
 */
let internalErrorLog: Logger = stderrLogger();

/** `429` codes that mean "the engine is busy with your other re-runs", not "you are over a budget". */
const ENGINE_BUSY_CODES = new Set(['ENGINE_BUSY', 'TOO_MANY_CONCURRENT_RERUNS', 'MONTE_CARLO_BUSY']);

export function setInternalErrorLogger(log: Logger): void {
  internalErrorLog = log;
}

/**
 * Everything a tool returns goes through here: size-checked, then masked — a key or token echoed by upstream never
 * reaches the model, on success as on failure (security audit, 2026-10-08).
 */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: mask(fitResponse(value).json) }] };
}

/**
 * How a failure reaches the model: the platform's own code, its message marked as untrusted upstream text, never a
 * stack. A `429` carries `retryAfterSec` and says plainly that a write was not retried — the gateway's limits are the
 * agent's pace. Anything unexpected becomes a generic `INTERNAL_ERROR` with an id;
 * its detail goes to the log only.
 */
export function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayError) {
    const body: Record<string, unknown> = {
      error: { status: error.status, code: error.code, message: untrusted(error.message), request: `${error.method} ${error.path}` },
    };
    if (error.rateLimited) {
      const retried = 'Reads were retried briefly before this answer; launches and saves are never repeated automatically.';
      const when = error.retryAfterSec === null ? 'Wait about a minute before calling this again.' : `Call again in ${error.retryAfterSec} s.`;
      const busy = ENGINE_BUSY_CODES.has(error.code)
        ? ' Engine-backed reads (backtest_get, backtest_near_miss, backtest_signals, a synchronous strategy_dry_run, backtest_monte_carlo) run at most 2 at a time per user: call them one after another, not in parallel.'
        : '';
      const quota = error.code.includes('QUOTA') ? ' This is a daily quota; it resets at 00:00 UTC.' : '';
      body.retryAfterSec = error.retryAfterSec;
      body.hint = `Rate limited (${error.code}). ${retried} ${when}${busy}${quota}`;
    }
    return body;
  }
  if (error instanceof ToolInputError) {
    return { error: { ...(error.status ? { status: error.status } : {}), code: error.code, message: error.message, ...(error.details ?? {}) } };
  }
  if (error instanceof TransportError) {
    return { error: { code: 'GATEWAY_UNREACHABLE', message: sanitizeText(error.message, 400) } };
  }
  const errorId = randomUUID().slice(0, 8);
  internalErrorLog.error(`internal error ${errorId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: `The MCP server failed unexpectedly while handling this call. The detail is in its stderr log under errorId ${errorId}.`,
      errorId,
    },
  };
}

export function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: mask(JSON.stringify(errorBody(error))) }] };
}

/** Wraps a handler: its return value is serialized and size-checked; anything it throws becomes an error answer. */
export function handle<A, E>(fn: (args: A, extra: E) => Promise<unknown>): (args: A, extra: E) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      return jsonResult(await fn(args, extra));
    } catch (error) {
      return errorResult(error);
    }
  };
}
