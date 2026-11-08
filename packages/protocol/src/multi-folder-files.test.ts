import { describe, expect, it } from 'vitest';
import { HOST_FEATURES, HostFeaturesSchema, MethodSchemas } from './index.js';
import { methodSamples } from './test-samples.js';

const methods = [
  'workspace.readFile',
  'workspace.fileUrl',
  'workspace.officePdf',
  'workspace.writeFile',
] as const;

describe('multi-folder files', () => {
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
    expect(HOST_FEATURES.multiFolderFiles).toBe('multi_folder_files');
    expect(HostFeaturesSchema.parse({})).toEqual({});
    expect(HostFeaturesSchema.parse({ multi_folder_files: true })).toEqual({
      multi_folder_files: true,
    });
    expect(HostFeaturesSchema.safeParse({ multi_folder_files: 'true' }).success).toBe(false);
  });
});
