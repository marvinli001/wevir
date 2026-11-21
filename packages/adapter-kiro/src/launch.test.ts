import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  decodeKiroSessionId,
  encodeKiroSessionId,
  type KiroGeneration,
  KiroLauncher,
  kiroGenerationForVersion,
} from './launch.js';

function launcher(generation: KiroGeneration, version: string | undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'wevir-kiro-launch-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return new KiroLauncher(
    directory,
    async () => ({ path: 'kiro-cli', env: {}, version }),
    generation,
  );
}

describe('Kiro ACP launch', () => {
  it('launches the V3 harness with CLI-owned authentication for stable CLI 3.x', async () => {
    const version = '3.0.0';
    const generation = kiroGenerationForVersion(version);
    const launch = await launcher(generation, version).prepare();
    expect(launch.spawnSpec().args).toEqual(['acp', '--agent-engine=v3', '--auth-method=cli']);
    expect(kiroGenerationForVersion('3.0.0-beta.1')).toBe('v2');
  });

  it.each(['2.36.0', '3.5.0'])('can explicitly launch V2 on CLI %s', async (version) => {
    const launch = await launcher('v2', version).prepare();
    expect(launch.spawnSpec().args).toEqual(['acp', '--agent-engine', 'v2']);
  });

  it.each(['2.35.0', undefined])(
    'omits the engine flag on legacy or unknown CLI %s',
    async (version) => {
      const generation = kiroGenerationForVersion(version);
      const launch = await launcher(generation, version).prepare();
      expect(launch.spawnSpec().args).toEqual(['acp']);
    },
  );

  it('refuses to launch a V3 session with a legacy CLI', async () => {
    await expect(launcher('v3', '2.36.0').prepare()).rejects.toThrow('requires Kiro CLI 3.0.0');
  });

  it('preserves legacy IDs and remembers the harness of new V3 sessions', () => {
    const id = 'd39df744-ae95-4f90-b1c0-1567fbcf38b0';
    expect(encodeKiroSessionId(id, 'v2')).toBe(id);
    expect(decodeKiroSessionId(id)).toEqual({ id, generation: 'v2' });
    const v3Id = encodeKiroSessionId(id, 'v3');
    expect(v3Id).toBe(`kiro-v3:${id}`);
    expect(decodeKiroSessionId(v3Id)).toEqual({ id, generation: 'v3' });
  });
});
