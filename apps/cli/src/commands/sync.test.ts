import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../context.js';
import { syncCall } from './sync.js';

const h = vi.hoisted(() => ({ request: vi.fn().mockResolvedValue({}) }));
vi.mock('../context.js', () => ({
  requireFeature: () => {},
  withClient: async (_ctx: unknown, action: (client: unknown) => unknown) => action(h),
}));
describe('sync filesystem paths', () => {
  it.each(['sync.importPrepare', 'sync.exportLocal'] as const)(
    'keeps %s paths relative to the remote Host',
    async (method) => {
      const field = method === 'sync.importPrepare' ? 'path' : 'directory';
      const ctx = {
        io: { cwd: '/cli/local' },
        remote: 'paired-computer',
        print: () => {},
      } as unknown as Context;
      await syncCall(ctx, method, { [field]: 'relative/archive' }, false);
      expect(h.request).toHaveBeenLastCalledWith(method, { [field]: 'relative/archive' });
    },
  );
});
