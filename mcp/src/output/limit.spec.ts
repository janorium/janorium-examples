import { byteLength, fitResponse, HARD_LIMIT_BYTES, TRUNCATION_HINT } from './limit';

describe('fitResponse', () => {
  it('passes a small answer through untouched', () => {
    const value = { a: 1, rows: [1, 2, 3] };
    expect(fitResponse(value)).toEqual({ json: JSON.stringify(value), bytes: byteLength(JSON.stringify(value)), truncated: false });
  });

  it('cuts the largest array until the answer fits, and marks it', () => {
    const value = { flags: ['X'], small: [1, 2, 3], bars: Array.from({ length: 5000 }, (_, i) => ({ i, note: 'x'.repeat(40) })) };
    const fitted = fitResponse(value);
    const parsed = JSON.parse(fitted.json);
    expect(fitted.truncated).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(HARD_LIMIT_BYTES);
    expect(parsed.small).toEqual([1, 2, 3]);
    expect(parsed.bars.length).toBeLessThan(5000);
    expect(parsed.bars[0]).toEqual({ i: 0, note: 'x'.repeat(40) });
    expect(parsed.flags).toEqual(['X', 'TRUNCATED']);
    expect(parsed.hint).toBe(TRUNCATION_HINT);
  });

  it('wraps a top-level array', () => {
    const fitted = fitResponse(Array.from({ length: 20000 }, (_, i) => i * 1000));
    const parsed = JSON.parse(fitted.json);
    expect(parsed.flags).toEqual(['TRUNCATED']);
    expect(Array.isArray(parsed.value)).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(HARD_LIMIT_BYTES);
  });

  it('falls back to a preview when a single string is too large', () => {
    const fitted = fitResponse({ text: 'y'.repeat(200_000) });
    expect(fitted.truncated).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(HARD_LIMIT_BYTES);
    expect(JSON.parse(fitted.json).preview).toBeDefined();
  });

  it('respects a custom limit', () => {
    expect(fitResponse({ rows: Array.from({ length: 500 }, (_, i) => i) }, 1024).bytes).toBeLessThanOrEqual(1024);
  });
});
