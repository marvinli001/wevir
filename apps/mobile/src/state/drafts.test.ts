import { describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({
  loadDraft: vi.fn(),
  saveDraft: vi.fn(async () => {}),
  forgetDrafts: vi.fn(async () => {}),
}));
vi.mock('../lib/cache-store', () => ({ openComputerCache: async () => cache }));

import { forgetDrafts, loadDraft, readDraftState } from './drafts';

describe('draft scope removal', () => {
  it('discards a late read from a forgotten computer without clearing another scope', async () => {
    cache.loadDraft.mockResolvedValueOnce(
      JSON.stringify({ v: 1, text: 'Independent draft', uncertain: false }),
    );
    await loadDraft('independent/session');
    let release = (_value: string) => {};
    cache.loadDraft.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const loading = loadDraft('forgotten/session');
    await vi.waitFor(() => expect(cache.loadDraft).toHaveBeenCalledTimes(2));
    await forgetDrafts('forgotten');
    release(JSON.stringify({ v: 1, text: 'Old private draft', uncertain: false }));
    expect(await loading).toEqual({ text: '', uncertain: false });
    expect(readDraftState('forgotten/session')).toEqual({ text: '', uncertain: false });
    expect(readDraftState('independent/session').text).toBe('Independent draft');
  });
});
