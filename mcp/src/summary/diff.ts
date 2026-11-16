import { untrustedStrings } from '../output/untrusted';

export interface ConfigChange {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface ConfigDiff {
  changes: ConfigChange[];
  /** More differences existed than `maxChanges`. */
  truncated: boolean;
}

/**
 * Structural diff of two strategy configs — paths, not text, so "which knob moved" is one line per knob no matter how
 * the JSON was formatted. Arrays compare by index, which is how the config addresses `entries[0]`.
 */
export function structuralDiff(before: unknown, after: unknown, maxChanges = 50): ConfigDiff {
  const changes: ConfigChange[] = [];
  let truncated = false;

  const push = (change: ConfigChange) => {
    if (changes.length >= maxChanges) {
      truncated = true;
      return;
    }
    changes.push(change);
  };

  const walk = (a: unknown, b: unknown, path: string) => {
    if (truncated) {
      return;
    }
    if (isContainer(a) && isContainer(b) && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.isArray(a)
        ? Array.from({ length: Math.max(a.length, (b as unknown[]).length) }, (_, i) => String(i))
        : Array.from(new Set([...Object.keys(a), ...Object.keys(b as object)]));
      for (const key of keys) {
        const childPath = Array.isArray(a) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
        const av = (a as Record<string, unknown>)[key];
        const bv = (b as Record<string, unknown>)[key];
        if (av === undefined) {
          push({ path: childPath, op: 'added', after: bv });
        } else if (bv === undefined) {
          push({ path: childPath, op: 'removed', before: av });
        } else {
          walk(av, bv, childPath);
        }
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      push({ path: path || '$', op: 'changed', before: a, after: b });
    }
  };

  walk(before, after, '');
  return { changes, truncated };
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/**
 * A diff is for reading, never fed back as a config: its string values — which, for another user's public strategy,
 * that user wrote — are marked like any other upstream text (security audit, 2026-10-08). Paths and numbers stay as they are.
 */
export function markDiffValues(changes: ConfigChange[]): ConfigChange[] {
  return changes.map((change) => ({
    ...change,
    ...('before' in change ? { before: untrustedStrings(change.before) } : {}),
    ...('after' in change ? { after: untrustedStrings(change.after) } : {}),
  }));
}
