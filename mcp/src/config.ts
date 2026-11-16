import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOC_RESOURCES } from './resources/doc-files';

/** The public platform. A local stack sets `CB_BASE_URL=http://localhost:8080/api/v1`. */
export const DEFAULT_BASE_URL = 'https://janorium.com/api/v1';

export interface ServerConfig {
  /** `cbk_…` — never printed; see `log.ts`. */
  apiKey: string;
  /** REST base, including `/api/v1`. */
  baseUrl: string;
  /** Origin the socket.io client connects to; the path is always `/ws/notifications`. */
  wsUrl: string;
  /**
   * `CB_ALLOW_INSECURE_HTTP=true` and at least one endpoint is cleartext to a non-loopback host — the key crosses a
   * network unencrypted. Allowed for a private network (the compose network); `index.ts` warns about it at start-up.
   */
  insecureTransport: boolean;
  /** `dist/docs` in the npm package, the repository's `docs/` in a checkout — the `docs://*` resources are read from here. */
  docsDir: string;
  /** Default `exchange` when a request and the strategy config both leave it out. */
  exchange: string;
  /** How often `wait` falls back to REST for runs that persist a status row. */
  pollIntervalMs: number;
  /**
   * `MCP_REQUIRE_CAMPAIGN` (default `false` since 2026-11-13, for the public npm package): `true` refuses runs without an
   * active campaign. Scripted strategy searches set it explicitly.
   */
  requireCampaign: boolean;
  /** `false` only with the explicit `--no-robustness-gate` argument. */
  robustnessGate: boolean;
  /** Where campaign ledgers are stored: `~/.crypto-backtesting/campaigns` unless `CB_CAMPAIGNS_DIR` says otherwise. */
  campaignsDir: string;
}

export class ConfigError extends Error {}

function flag(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) {
    return fallback;
  }
  return !['false', '0', 'no', 'off'].includes(v);
}

/** An opt-out of a safety check is on only when spelled as one — a typo must not switch it on. */
function explicitlyTrue(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((value ?? '').trim().toLowerCase());
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** `localhost`, `127.0.0.0/8` and `::1` — traffic that never leaves the machine. `URL.hostname` keeps IPv6 brackets. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host);
}

function endpoint(name: string, raw: string, protocols: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL.`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new ConfigError(`${name} must use ${protocols.map((p) => `${p}//`).join(' or ')}; got ${url.protocol}//.`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not carry credentials (user:password@host); the API key is the only credential this server sends.`);
  }
  return url;
}

/** `true` when the URL is cleartext to a host off this machine. */
function cleartextOffHost(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'ws:') && !isLoopbackHost(url.hostname);
}

/**
 * Where the `docs://*` references come from. The npm package carries them next to the bundle (`dist/docs`, written by
 * tsup). A source checkout without that build reads them from source: `docs/` next to `src/` in the public source,
 * else the development repository's `docs/`, two levels above the package (`dist/` and `src/` sit at the same depth, so
 * one expression serves the build and ts-node).
 */
export function defaultDocsDir(dir: string = __dirname): string {
  const complete = [path.join(dir, 'docs'), path.resolve(dir, '..', 'docs')].find((candidate) =>
    DOC_RESOURCES.every((doc) => existsSync(path.join(candidate, doc.file))),
  );
  return complete ?? path.resolve(dir, '..', '..', '..', 'docs');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): ServerConfig {
  const apiKey = (env.CB_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new ConfigError(
      'CB_API_KEY is not set. Create a key on janorium.com in Settings → API keys (scopes read, run; optimize/research/publish as needed).',
    );
  }
  if (!apiKey.startsWith('cbk_')) {
    throw new ConfigError('CB_API_KEY must be a platform API key (it starts with cbk_). A JWT access token expires in 15 minutes and is not accepted.');
  }
  const baseUrl = (env.CB_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const base = endpoint('CB_BASE_URL', baseUrl, ['http:', 'https:']);
  const wsUrl = env.CB_WS_URL?.trim() || base.origin;
  const ws = endpoint('CB_WS_URL', wsUrl, ['http:', 'https:', 'ws:', 'wss:']);

  // The key rides on every request (Authorization) and in every socket.io CONNECT packet, reconnects included: over
  // cleartext to another host it is readable by anyone on the path (security audit, 2026-10-08).
  const offHost = [
    { name: 'CB_BASE_URL', url: base },
    { name: 'CB_WS_URL', url: ws },
  ].filter((e) => cleartextOffHost(e.url));
  const allowInsecure = explicitlyTrue(env.CB_ALLOW_INSECURE_HTTP);
  if (offHost.length > 0 && !allowInsecure) {
    const named = offHost.map((e) => `${e.name}=${e.url.origin}`).join(', ');
    throw new ConfigError(
      `${named} would send the API key in clear text to a host other than this machine. Use https:// (wss:// for CB_WS_URL), or set CB_ALLOW_INSECURE_HTTP=true for a trusted private network such as the docker compose network.`,
    );
  }

  return {
    apiKey,
    baseUrl,
    wsUrl,
    insecureTransport: offHost.length > 0,
    docsDir: env.CB_DOCS_DIR?.trim() || defaultDocsDir(),
    exchange: env.CB_EXCHANGE?.trim() || 'binance',
    pollIntervalMs: Number(env.CB_POLL_INTERVAL_MS ?? 5000) || 5000,
    requireCampaign: flag(env.MCP_REQUIRE_CAMPAIGN, false),
    // An argument, not an env var: switching the gate off has to be visible in the command line that launched the server.
    robustnessGate: !argv.includes('--no-robustness-gate'),
    campaignsDir: env.CB_CAMPAIGNS_DIR?.trim() || path.join(os.homedir(), '.crypto-backtesting', 'campaigns'),
  };
}
