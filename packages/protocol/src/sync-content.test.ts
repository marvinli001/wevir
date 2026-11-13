import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SYNC_CONTENT_SCHEMAS } from './sync-content.js';

const root = new URL('../../../contracts/wevir-content/v1/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
describe('versioned Wevir content artifacts', () => {
  it('publishes the runtime schemas separately from the gateway wire version', () => {
    expect(read('version.json')).toMatchObject({
      protocol: 'wevir-content/1',
      artifactRevision: 1,
      status: 'proposed',
      cloudProtocol: 'wevir-sync/1',
    });
    for (const [name, schema] of Object.entries(SYNC_CONTENT_SCHEMAS)) {
      const { $id, ...artifact } = read(`${name}.schema.json`);
      expect($id).toBe(`urn:wevir:content:1:${name}`);
      expect(z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' })).toEqual(
        artifact,
      );
    }
  });
  it('consumes every public legal and illegal fixture', () => {
    const fixtures = read('fixtures.json') as {
      valid: Array<{ schema: keyof typeof SYNC_CONTENT_SCHEMAS; value: unknown }>;
      invalid: Array<{ schema: keyof typeof SYNC_CONTENT_SCHEMAS; value: unknown }>;
    };
    for (const [values, accepted] of [
      [fixtures.valid, true],
      [fixtures.invalid, false],
    ] as const)
      for (const fixture of values)
        expect(
          SYNC_CONTENT_SCHEMAS[fixture.schema].safeParse(fixture.value).success,
          fixture.schema,
        ).toBe(accepted);
    expect(new Set(fixtures.valid.map((value) => value.schema))).toEqual(
      new Set(Object.keys(SYNC_CONTENT_SCHEMAS)),
    );
  });
});
