import { describe, expect, it } from 'vitest';
import { HOST_FEATURES, HostFeaturesSchema, MethodSchemas } from './index.js';
import { methodSamples } from './test-samples.js';

const methods = [
  'workspace.git',
  'workspace.diff',
  'workspace.diffFile',
  'git.status',
  'git.stage',
  'git.unstage',
  'git.commit',
] as const;

describe('multi-folder changes', () => {
  it.each(methods)('%s preserves folder and accepts existing calls', (method) => {
    const schema = MethodSchemas[method].params;
    const params = methodSamples[method].params.valid[0];
    expect(schema.parse(params)).not.toHaveProperty('folder');
    for (const folder of ['/work/extra', 'C:\\work\\extra']) {
      expect(schema.parse({ ...params, folder })).toHaveProperty('folder', folder);
    }
    expect(schema.safeParse({ ...params, folder: '' }).success).toBe(false);
    expect(schema.safeParse({ ...params, folder: 1 }).success).toBe(false);
  });

  it('advertises folder support without changing older feature objects', () => {
    expect(HOST_FEATURES.multiFolderChanges).toBe('multi_folder_changes');
    expect(HostFeaturesSchema.parse({})).toEqual({});
    expect(HostFeaturesSchema.parse({ multi_folder_changes: true })).toEqual({
      multi_folder_changes: true,
    });
    expect(HostFeaturesSchema.safeParse({ multi_folder_changes: 'true' }).success).toBe(false);
  });
});
