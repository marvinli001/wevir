import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { x25519 } from '@noble/curves/ed25519.js';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { NOISE_KEY_REF, RemoteIdentity, ROUTE_KEY_REF } from './identity.js';

const tempDir = useTempDir();

describe('RemoteIdentity', () => {
  it('第一次生成两对密钥存进 secrets.json，之后读回同一对', async () => {
    const dir = tempDir();
    const secrets = new FileSecretStore(dir);
    const first = new RemoteIdentity({ secrets });
    const [a, b] = await Promise.all([first.ensure(), first.ensure()]);
    expect(a).toBe(b);
    expect(a.hostPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.routeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hostPublicKey).not.toBe(a.routeId);
    expect(Buffer.from(x25519.getPublicKey(a.noise.secretKey)).toString('base64url')).toBe(
      a.hostPublicKey,
    );
    const file = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
    expect(Object.keys(file.secrets).sort()).toEqual([NOISE_KEY_REF, ROUTE_KEY_REF]);

    const again = await new RemoteIdentity({ secrets: new FileSecretStore(dir) }).ensure();
    expect(again.hostPublicKey).toBe(a.hostPublicKey);
    expect(again.routeId).toBe(a.routeId);
  });

  it('条目读不懂或公钥对不上私钥时重新生成', async () => {
    const dir = tempDir();
    const secrets = new FileSecretStore(dir);
    const original = await new RemoteIdentity({ secrets }).ensure();
    await secrets.set(NOISE_KEY_REF, 'not json');
    const stored = JSON.parse((await secrets.get(ROUTE_KEY_REF)) as string);
    await secrets.set(
      ROUTE_KEY_REF,
      JSON.stringify({ ...stored, publicKey: original.hostPublicKey }),
    );
    const regenerated = await new RemoteIdentity({ secrets }).ensure();
    expect(regenerated.hostPublicKey).not.toBe(original.hostPublicKey);
    expect(regenerated.routeId).not.toBe(original.routeId);
  });
});
