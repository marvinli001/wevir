import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { mergeMemoryText, mergeSyncText } from './text-merge.js';

const temp = useTempDir();
describe('merge line endings', () => {
  const base = 'Alpha\n\nMiddle\n\nOmega\n';
  it('merges independent LF and CRLF edits without treating line endings as edits', async () => {
    expect(
      await mergeSyncText(
        temp(),
        base,
        base.replace('Alpha', 'Local alpha'),
        base.replace('Omega', 'Remote omega').replaceAll('\n', '\r\n'),
      ),
    ).toBe('Local alpha\n\nMiddle\n\nRemote omega\n');
  });
  it('preserves local CRLF when only the remote content changed', async () => {
    expect(
      await mergeSyncText(
        temp(),
        base,
        base.replaceAll('\n', '\r\n'),
        base.replace('Omega', 'Remote omega'),
      ),
    ).toBe('Alpha\r\n\r\nMiddle\r\n\r\nRemote omega\r\n');
  });
  it('preserves CRLF across memory metadata and body after a merge', async () => {
    const header = '---\nname: synthetic\ntype: project\ndescription: Synthetic note\n---\n';
    const merged = await mergeMemoryText(
      temp(),
      (header + base).replaceAll('\n', '\r\n'),
      (header + base.replace('Alpha', 'Local alpha')).replaceAll('\n', '\r\n'),
      header + base.replace('Omega', 'Remote omega'),
    );
    expect(merged).toContain('Local alpha\r\n\r\nMiddle\r\n\r\nRemote omega\r\n');
    expect(merged).toContain('updated-by: user\r\n');
    expect(merged).not.toMatch(/(?<!\r)\n/);
  });
});
