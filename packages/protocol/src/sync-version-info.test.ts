import { describe, expect, it } from 'vitest';
import frozen from './compat/0.189.0.json' with { type: 'json' };
import { MethodSchemas } from './methods.js';
import { SyncVersionInfoSchema } from './sync-version-info.js';

describe('optional Host version provenance', () => {
  it('preserves display metadata through an RPC result parser', () => {
    const value = MethodSchemas['sync.previewSettingsMerge'].result.parse(
      frozen.methods['sync.previewSettingsMerge'].result[0],
    );
    expect(value.versions[0]).toMatchObject({
      deviceId: 'device_fixture',
      clientTime: '2026-11-14T00:00:00.000Z',
    });
  });
  it('accepts older results and rejects malformed optional metadata', () => {
    expect(SyncVersionInfoSchema.safeParse({}).success).toBe(true);
    expect(
      SyncVersionInfoSchema.safeParse({ deviceId: '../device', clientTime: 'yesterday' }).success,
    ).toBe(false);
  });
});
