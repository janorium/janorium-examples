/** What a tool answer is designed to fit in. Checked by the unit tests. */
export const TARGET_BYTES = 8 * 1024;
/** The measured ceiling: serialize, check, cut. */
export const HARD_LIMIT_BYTES = 64 * 1024;

/** Room kept for the `TRUNCATED` flag and hint added after cutting. */
const MARKER_RESERVE = 512;

export const TRUNCATION_HINT =
  'The answer exceeded 64 KB and its longest arrays were cut. Ask for less: a page/size, a narrower from/to, a smaller top, or one layer.';

export interface FittedResponse {
  json: string;
  bytes: number;
  truncated: boolean;
}

export const byteLength = (json: string) => Buffer.byteLength(json, 'utf8');

/**
 * Serialize-and-check, the same discipline as the dry-run's `explain` block: measure the JSON that would actually be
 * sent and, only if it is over, halve the largest array until it fits. A cut answer says so (`flags: ["TRUNCATED"]` and
 * a hint) — a silently shortened list reads as a complete one.
 */
export function fitResponse(value: unknown, limitBytes = HARD_LIMIT_BYTES): FittedResponse {
  let json = JSON.stringify(value ?? null);
  if (byteLength(json) <= limitBytes) {
    return { json, bytes: byteLength(json), truncated: false };
  }
  const budget = limitBytes - MARKER_RESERVE;
  const copy = JSON.parse(json) as unknown;
  while (byteLength(JSON.stringify(copy)) > budget) {
    const largest = largestArray(copy);
    if (!largest || largest.length <= 1) {
      break;
    }
    largest.length = Math.floor(largest.length / 2);
  }
  let marked: unknown;
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    const record = copy as Record<string, unknown>;
    const flags = Array.isArray(record.flags) ? [...(record.flags as unknown[]), 'TRUNCATED'] : ['TRUNCATED'];
    marked = { ...record, flags, hint: TRUNCATION_HINT };
  } else {
    marked = { flags: ['TRUNCATED'], hint: TRUNCATION_HINT, value: copy };
  }
  json = JSON.stringify(marked);
  if (byteLength(json) > limitBytes) {
    // Nothing array-shaped left to cut — one enormous string. A prefix is still more useful than an error.
    json = JSON.stringify({ flags: ['TRUNCATED'], hint: TRUNCATION_HINT, preview: json.slice(0, Math.floor(budget / 2)) });
  }
  return { json, bytes: byteLength(json), truncated: true };
}

function largestArray(root: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  let bestSize = -1;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      const size = JSON.stringify(node).length;
      if (node.length > 1 && size > bestSize) {
        best = node;
        bestSize = size;
      }
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(root);
  return best;
}
