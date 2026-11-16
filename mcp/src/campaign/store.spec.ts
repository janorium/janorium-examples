import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CampaignStore, isCampaignId, type Campaign } from './store';

function campaign(id: string, overrides: Partial<Campaign> = {}): Campaign {
  return {
    formatVersion: 1,
    id,
    name: 'c',
    status: 'ACTIVE',
    createdAt: '2026-10-09T00:00:00Z',
    strategyId: null,
    symbols: ['BTCUSDT'],
    timeframes: ['1h'],
    from: '2022-01-01T00:00:00Z',
    to: '2025-01-01T00:00:00Z',
    holdoutFrom: '2024-01-01T00:00:00Z',
    parentCampaignId: null,
    inheritedTrials: 0,
    robustnessGate: 'ENFORCED',
    supersededBy: null,
    trials: [],
    checks: [],
    refusals: [],
    finalization: null,
    ...overrides,
  };
}

describe('CampaignStore paths', () => {
  const fresh = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-store-'));
    return { dir, store: new CampaignStore(dir) };
  };

  it('accepts only plain ids', () => {
    expect(isCampaignId('3f2c9a4e-0b7d-4c1e-9a55-1d2e3f4a5b6c')).toBe(true);
    for (const bad of ['', '../x', '..', 'a/b', 'a\\b', 'C:x', 'x.json', 'a'.repeat(65), 'a b']) {
      expect(isCampaignId(bad)).toBe(false);
    }
  });

  it('round-trips a campaign and refuses to write one with a path-like id', () => {
    const { dir, store } = fresh();
    store.save(campaign('abc-1'));
    expect(store.load('abc-1')?.id).toBe('abc-1');
    expect(() => store.save(campaign('../escape'))).toThrow(/plain id/);
    expect(readdirSync(dir)).toEqual(['abc-1.json']);
    expect(existsSync(path.join(dir, '..', 'escape.json'))).toBe(false);
  });

  it('never reads outside the directory', () => {
    const { store } = fresh();
    expect(store.load('../../etc/passwd')).toBeNull();
    expect(store.load('..')).toBeNull();
  });

  it('ignores a file whose id is not its own name, so a write cannot be redirected', () => {
    const { dir, store } = fresh();
    writeFileSync(path.join(dir, 'victim.json'), JSON.stringify(campaign('../../outside')));
    writeFileSync(path.join(dir, 'other.json'), JSON.stringify(campaign('someone-else')));
    expect(store.load('victim')).toBeNull();
    expect(store.load('other')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('ignores a file with the wrong shape or a path-like parent id', () => {
    const { dir, store } = fresh();
    writeFileSync(path.join(dir, 'bad-shape.json'), JSON.stringify({ formatVersion: 1, id: 'bad-shape' }));
    writeFileSync(path.join(dir, 'bad-parent.json'), JSON.stringify(campaign('bad-parent', { parentCampaignId: '../x' })));
    writeFileSync(path.join(dir, 'not-json.json'), '{');
    store.save(campaign('good'));
    expect(store.list().map((c) => c.id)).toEqual(['good']);
  });
});
