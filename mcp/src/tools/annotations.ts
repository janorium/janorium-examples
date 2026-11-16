import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/*
 * MCP tool annotations (security audit, 2026-10-08): what a client needs to decide which calls to confirm with the user.
 * Every tool talks only to this platform's gateway, so none of them is open-world. "Environment" includes the campaign
 * ledger: a call that adds a trial row changes the count the Deflated Sharpe is corrected for, so it is not read-only.
 */

/** Reads. Refreshing ledger rows that already exist (a finished run's numbers) is not a change of state. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Creates something new — a run, a persisted report, a ledger row — and spends compute or quota; overwrites nothing. */
export const ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Overwrites in place or spends something irreversibly: a strategy's current revision, the active campaign, the holdout. */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/**
 * Flips a switch the user can flip back, but outward-facing: a PUBLIC strategy's config is shown to every user and
 * guest. Destructive so a client confirms it; idempotent because setting the same value twice changes nothing.
 */
export const PUBLISHING: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
