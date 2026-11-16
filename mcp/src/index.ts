import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { io } from 'socket.io-client';
import { CampaignManager } from './campaign/manager';
import { CampaignStore } from './campaign/store';
import { ConfigError, loadConfig } from './config';
import { PlatformApi } from './gateway/api';
import { GatewayClient } from './gateway/client';
import { mask, stderrLogger } from './log';
import { createServer } from './server';
import { NotificationHub } from './ws/notifications';

async function main(): Promise<void> {
  const log = stderrLogger();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  if (config.insecureTransport) {
    log.warn(
      `CB_ALLOW_INSECURE_HTTP=true: the API key travels in clear text to ${config.baseUrl} / ${config.wsUrl}. Acceptable on a private network (the compose network) only.`,
    );
  }

  // The client is built before the campaign manager (which needs the api), so the header is read through a late binding.
  let campaigns: CampaignManager | null = null;
  const api = new PlatformApi(new GatewayClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: () => campaigns?.headers() ?? {} }));
  // The key goes in the socket.io CONNECT packet, not an HTTP header: the platform's notification service checks it
  // there, and the gateway's /ws route never sees it. websocket-only, because a long-polling POST
  // through the gateway would need a scope no key has. Never in `query`: the handshake URL (and every reconnect's) then
  // carries no secret for a proxy or access log to keep; each reconnect re-sends `auth` inside the socket, over wss://
  // whenever the host is not this machine (config.ts, security audit 2026-10-08).
  const hub = new NotificationHub(
    () =>
      io(config.wsUrl, {
        path: '/ws/notifications',
        transports: ['websocket'],
        auth: (send) => send({ token: config.apiKey }),
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
      }),
    log,
  );
  hub.start();

  campaigns = new CampaignManager(
    new CampaignStore(config.campaignsDir),
    api,
    hub,
    { requireCampaign: config.requireCampaign, robustnessGate: config.robustnessGate, exchange: config.exchange, pollIntervalMs: config.pollIntervalMs },
    log,
  );
  if (!config.robustnessGate) {
    log.warn('robustness gate DISABLED (--no-robustness-gate): campaign_finalize will not require date shifts, randomized entries or Monte Carlo');
  }

  const server = createServer({ api, hub, config, log, dryRuns: new Map(), campaigns });
  const shutdown = async (reason: string) => {
    log.info(`shutting down (${reason})`);
    hub.close();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin closed'));

  await server.connect(new StdioServerTransport());
  log.info(
    `ready — gateway ${config.baseUrl}, notifications ${config.wsUrl}, docs ${config.docsDir}, campaigns ${config.campaignsDir} (required: ${config.requireCampaign})`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`mcp-server failed to start: ${mask(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
  process.exit(1);
});
