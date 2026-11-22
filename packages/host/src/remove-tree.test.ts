import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTree, removeTreeSync } from './remove-tree.js';

function treeWithAsar(): string {
  const root = mkdtempSync(join(tmpdir(), 'wevir-remove-tree-'));
  const dir = join(root, 'node_modules', 'electron', 'Resources');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'default_app.asar'), 'not a real archive');
  return root;
}

describe('removeTree', () => {
  it('removes a tree that contains .asar files', async () => {
    const root = treeWithAsar();
    await removeTree(root);
    expect(existsSync(root)).toBe(false);
  });

  it('removes synchronously and ignores missing paths', async () => {
    const root = treeWithAsar();
    removeTreeSync(root);
    expect(existsSync(root)).toBe(false);
    removeTreeSync(root);
    await expect(removeTree(root)).resolves.toBeUndefined();
  });
});
