/**
 * stderr-only logging. In stdio mode stdout *is* the MCP transport, so a single stray `console.log` corrupts the
 * protocol stream — nothing in this package writes to stdout except the SDK's transport.
 *
 * Every line passes through {@link mask}: an API key must never reach a log, including inside an error message echoed
 * back from a library. Every tool answer and resource passes through it too
 * (security audit, 2026-10-08) — a key or a token echoed by upstream must not reach the model either.
 */
const KEY_PATTERN = /cbk_[A-Za-z0-9_-]+/g;
/** A JWT (header.payload.signature, the header always base64url of `{"`) — an access token echoed by upstream. */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

export function mask(text: string): string {
  return text.replace(KEY_PATTERN, (key) => `${key.slice(0, 8)}…`).replace(JWT_PATTERN, 'eyJ…[jwt]');
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function stderrLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  const emit = (level: string, message: string) => write(`${new Date().toISOString()} [mcp-server] ${level} ${mask(message)}\n`);
  return {
    info: (message) => emit('INFO', message),
    warn: (message) => emit('WARN', message),
    error: (message) => emit('ERROR', message),
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
