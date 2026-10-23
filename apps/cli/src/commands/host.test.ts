import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledResourcesDir, resolveHostEntry } from './host.js';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bundledResourcesDir / resolveHostEntry', () => {
  it('finds lib/ next to the CLI bundle of the command-line package', () => {
    const lib = mkdtempSync(join(tmpdir(), 'wevir-cli-lib-'));
    temps.push(lib);
    mkdirSync(join(lib, 'cli'));
    mkdirSync(join(lib, 'host', 'dist'), { recursive: true });
    writeFileSync(join(lib, 'host', 'dist', 'main.js'), '');
    const main = pathToFileURL(join(lib, 'cli', 'main.js'));
    const dir = bundledResourcesDir(main);
    expect(dir).toBe(lib);
    expect(resolveHostEntry(dir)).toBe(join(lib, 'host', 'dist', 'main.js'));
  });

  it('is not a package during development, where the Host comes from @wevir/host', () => {
    expect(bundledResourcesDir()).toBeUndefined();
    expect(bundledResourcesDir(pathToFileURL(join(tmpdir(), 'nowhere', 'cli', 'main.js')))).toBe(
      undefined,
    );
  });
});
