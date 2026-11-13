import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  reveal: vi.fn().mockResolvedValue(undefined),
  file: vi.fn(),
  files: vi.fn(),
}));
vi.mock('@/platform/platform', () => ({
  capabilities: () => ({ localFiles: true }),
  platformApi: () => ({ revealPath: calls.reveal }),
}));
vi.mock('@/data/workbench-data', () => ({ useWorkbenchSelector: vi.fn() }));
vi.mock('./files-store', () => ({ openFile: calls.file, openFiles: calls.files }));

import { openFileLink } from './file-links';

beforeEach(() => vi.clearAllMocks());
describe('synchronized file links', () => {
  it('keeps source links inside the controlled preview without native folder fallbacks', () => {
    openFileLink(undefined, '/synthetic/project', '/outside/local.txt', ['/outside'], true);
    expect(calls.file).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
    openFileLink(undefined, '/synthetic/project', 'report.md', [], true);
    expect(calls.file).toHaveBeenCalledWith(undefined, 'report.md', undefined);
  });

  it('retains the native behavior for ordinary local sessions', () => {
    openFileLink(undefined, '/synthetic/project', '/outside/local.txt');
    expect(calls.reveal).toHaveBeenCalledWith('/outside/local.txt');
    openFileLink(undefined, '/synthetic/project', '/extra/local.txt', ['/extra']);
    expect(calls.file).toHaveBeenCalledWith(undefined, '/extra/local.txt', undefined);
  });
});
