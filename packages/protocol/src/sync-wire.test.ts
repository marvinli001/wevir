import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateSyncBatch } from './sync-validation.js';
import { jcs, schemas, validateOperation } from './sync-wire.js';

const root = new URL('../../../contracts/wevir-sync/v1/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

describe('wevir-sync/1 artifact revision 1', () => {
  it('consumes the frozen schemas without changing their wire format', () => {
    expect(read('version.json')).toMatchObject({
      protocol: 'wevir-sync/1',
      artifactRevision: 1,
      status: 'frozen',
    });
    for (const [name, schema] of Object.entries(schemas)) {
      const { $id: _id, ...artifact } = read(`${name}.schema.json`);
      expect(
        z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
        name,
      ).toEqual(artifact);
    }
  });

  it('consumes the shared legal, illegal and semantic fixtures', () => {
    const fixtures = read('fixtures.json');
    for (const [group, accepted] of [
      ['valid', true],
      ['invalid', false],
    ] as const) {
      for (const fixture of fixtures[group]) {
        const schema = schemas[fixture.schema as keyof typeof schemas];
        expect(schema.safeParse(fixture.value).success, jcs(fixture)).toBe(accepted);
      }
    }
    for (const value of read('semantic-fixtures.json').invalid)
      expect(() => validateOperation(value)).toThrow();
  });

  it('binds a single manifest to each operation and its original record index', () => {
    const batch = read('fixtures.json').valid.find(
      (x: { schema: string }) => x.schema === 'commit',
    ).value;
    expect(validateSyncBatch(batch)).toEqual(batch);
    expect(() => validateSyncBatch({ ...batch, recordManifest: [] })).toThrow();
    expect(() =>
      validateSyncBatch({
        ...batch,
        recordManifest: [...batch.recordManifest, ...batch.recordManifest],
      }),
    ).toThrow();
    expect(() =>
      validateSyncBatch({
        ...batch,
        recordManifest: [{ ...batch.recordManifest[0], recordIndex: 1 }],
      }),
    ).toThrow();
    expect(() =>
      validateSyncBatch({ ...batch, operations: [...batch.operations, ...batch.operations] }),
    ).toThrow();
  });

  it('bounds ranges before expanding them and requires contiguous fingerprints and project ownership', () => {
    const base = read('fixtures.json').valid[0].value;
    const operation = {
      ...base,
      entityType: 'event-segment',
      origin: {
        hostId: 'host_fixture',
        sessionId: 'session_fixture',
        streamId: 'stream_fixture',
        fromSeq: '1',
        throughSeq: '2',
      },
    };
    const manifest = {
      opId: base.opId,
      ...base.payload,
      projectId: 'project_fixture',
      events: [
        { seq: '1', sha256: 'A'.repeat(43) },
        { seq: '2', sha256: 'B'.repeat(43) },
      ],
    };
    const batch = {
      commitId: 'commit_fixture',
      operations: [operation],
      recordManifest: [manifest],
    };
    expect(validateSyncBatch(batch)).toEqual(batch);
    expect(() =>
      validateSyncBatch({
        ...batch,
        operations: [
          {
            ...operation,
            origin: { ...operation.origin, throughSeq: '9999999999999999999999999' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateSyncBatch({ ...batch, recordManifest: [{ ...manifest, projectId: undefined }] }),
    ).toThrow();
    expect(() =>
      validateSyncBatch({
        ...batch,
        recordManifest: [{ ...manifest, events: [manifest.events[0], manifest.events[0]] }],
      }),
    ).toThrow();
  });

  it('uses JCS Unicode, numeric and nesting rules', () => {
    expect(jcs({ emoji: '😀', z: -0, a: 1e30 })).toBe('{"a":1e+30,"emoji":"😀","z":0}');
    expect(() => jcs({ text: '\ud800' })).toThrow();
    expect(() => jcs({ number: Number.NaN })).toThrow();
    let nested: unknown = null;
    for (let i = 0; i < 66; i++) nested = [nested];
    expect(() => jcs(nested)).toThrow();
  });
});
