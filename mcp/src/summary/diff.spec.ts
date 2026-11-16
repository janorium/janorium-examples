import { structuralDiff } from './diff';

describe('structuralDiff', () => {
  it('names changed, added and removed paths', () => {
    const before = { risk: { stopLossPct: 2 }, entries: [{ id: 'a', condition: { all: [1, 2] } }], old: true };
    const after = { risk: { stopLossPct: 1.5, takeProfitPct: 4 }, entries: [{ id: 'a', condition: { all: [1] } }] };
    expect(structuralDiff(before, after).changes).toEqual([
      { path: 'risk.stopLossPct', op: 'changed', before: 2, after: 1.5 },
      { path: 'risk.takeProfitPct', op: 'added', after: 4 },
      { path: 'entries[0].condition.all[1]', op: 'removed', before: 2 },
      { path: 'old', op: 'removed', before: true },
    ]);
  });

  it('is empty for equal configs regardless of key order', () => {
    expect(structuralDiff({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual({ changes: [], truncated: false });
  });

  it('stops at maxChanges and says so', () => {
    const a = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const b = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i + 1]));
    const diff = structuralDiff(a, b, 3);
    expect(diff.changes).toHaveLength(3);
    expect(diff.truncated).toBe(true);
  });

  it('treats a type change as one change', () => {
    expect(structuralDiff({ x: [1] }, { x: { 0: 1 } }).changes).toEqual([{ path: 'x', op: 'changed', before: [1], after: { 0: 1 } }]);
  });
});
