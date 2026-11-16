const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  M: 30 * 86_400_000,
};

/** `15m` → 900000. `null` for anything that is not a timeframe the platform names. */
export function timeframeMs(timeframe: string): number | null {
  const match = /^(\d+)([mhdwM])$/.exec(timeframe.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

/** Accepts `2024-01-01` as a convenience and sends the ISO instant the REST contract expects. */
export function toInstant(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00Z`;
  }
  return trimmed;
}
