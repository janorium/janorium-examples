import type { CampaignManager } from '../campaign/manager';
import type { ServerConfig } from '../config';
import type { PlatformApi } from '../gateway/api';
import type { Logger } from '../log';
import type { DryRunLaunch } from '../summary/run-summary';
import type { NotificationHub } from '../ws/notifications';

export interface ToolContext {
  api: PlatformApi;
  hub: NotificationHub;
  config: Pick<ServerConfig, 'exchange' | 'pollIntervalMs' | 'docsDir'>;
  log: Logger;
  /** What each async dry-run was launched with, by `dryRunId` — its socket event does not repeat it. */
  dryRuns: Map<string, DryRunLaunch>;
  /** The campaign protocol: the holdout lock every launch and read passes, and the ledger it writes. */
  campaigns: CampaignManager;
}
