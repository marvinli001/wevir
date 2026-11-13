import { mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { z } from 'zod';

const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('./') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(sourceRoot)
    )
      return next(specifier.replace(/\.js$/, '.ts'), context);
    return next(specifier, context);
  },
});
const { SYNC_CONTENT_SCHEMAS } = await import('../src/sync-content.ts');
const { EpisodeSchema } = await import('../src/context.ts');
const { episode } = await import('../src/test-samples.ts');
const { PROTOCOL_VERSION } = await import('../src/version.ts');
const directory = new URL('../../../contracts/wevir-content/v1/', import.meta.url);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) =>
  writeFileSync(new URL(name, directory), `${JSON.stringify(value, null, 2)}\n`);
for (const [name, schema] of Object.entries(SYNC_CONTENT_SCHEMAS))
  write(`${name}.schema.json`, {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
    $id: `urn:wevir:content:1:${name}`,
  });
const source = {
  hostId: 'host_synthetic',
  deviceId: 'device_synthetic',
  sessionId: 'ses_synthetic',
  streamId: 'stream_synthetic',
};
const at = '2026-11-13T00:00:00.000Z';
const task = EpisodeSchema.parse({
  ...episode,
  id: 'ep_synthetic',
  workspaceId: 'ws_synthetic',
  sessionId: source.sessionId,
  rootSessionId: source.sessionId,
  title: 'Synthetic task',
});
const values = {
  sharedFiles: { schema: 'wevir-shared-files/1', source, seq: '12', capture: 'shared' },
  project: {
    schema: 'wevir-project/1',
    projectId: 'project_synthetic',
    displayName: 'Synthetic project',
  },
  session: {
    schema: 'wevir-session/1',
    source,
    sessionId: source.sessionId,
    throughSeq: '3',
    title: 'Synthetic task',
    titleSource: 'user',
    providerId: 'synthetic-api',
    modelId: 'synthetic-model',
    engine: 'echo',
    createdAt: at,
  },
  'event-stream': {
    schema: 'wevir-event-stream/1',
    sessionId: source.sessionId,
    streamId: source.streamId,
    exclusions: ['engine.raw'],
  },
  episode: {
    schema: 'wevir-episode/1',
    source,
    episodeId: task.id,
    episode: task,
    deleted: false,
    createdAt: at,
    updatedAt: at,
  },
  'retro-summary': {
    schema: 'wevir-retro-summary/1',
    source,
    summary: {
      points: [{ text: 'Synthetic summary', refs: ['e3'] }],
      providerId: 'synthetic-api',
      modelId: 'synthetic-model',
      throughSeq: 3,
      generatedAt: at,
      inputBytes: 128,
      outputBytes: 32,
    },
  },
  'session-state': {
    schema: 'wevir-session-state/1',
    source,
    title: 'Synthetic renamed task',
    titleSource: 'user',
    archivedAt: null,
  },
  'session-tombstone': { schema: 'wevir-session-deleted/1', source, deletedAt: at },
  memory: {
    schema: 'wevir-memory/1',
    scope: 'global',
    name: 'synthetic-note',
    markdown:
      '---\nname: synthetic-note\ntype: project\ndescription: Synthetic\n---\nSynthetic content\n',
  },
  settings: {
    schema: 'wevir-settings/1',
    values: { outputStyle: 'concise', autoMemory: false },
    exclusions: ['remote', 'computerUse', 'routing'],
  },
  chunk: {
    schema: 'wevir-chunk/1',
    ownerId: 'bundle_synthetic',
    index: 0,
    data: '',
    sha256: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
  },
  bundle: {
    schema: 'wevir-bundle/1',
    category: 'skill-bundle',
    name: 'Synthetic skill',
    files: [
      {
        path: 'SKILL.md',
        bytes: 0,
        sha256: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
        parts: [],
      },
    ],
    exclusions: ['.env'],
  },
};
for (const [name, value] of Object.entries(values))
  SYNC_CONTENT_SCHEMAS[name as keyof typeof SYNC_CONTENT_SCHEMAS].parse(value);
write('fixtures.json', {
  valid: Object.entries(values).map(([schema, value]) => ({ schema, value })),
  invalid: [
    { schema: 'sharedFiles', value: { ...values.sharedFiles, seq: '-1' } },
    { schema: 'session-state', value: { ...values['session-state'], archivedAt: 'invalid' } },
    { schema: 'settings', value: { ...values.settings, values: { computerUse: true } } },
    {
      schema: 'bundle',
      value: { ...values.bundle, files: [{ ...values.bundle.files[0], path: '../escape' }] },
    },
    { schema: 'episode', value: { ...values.episode, deleted: 'false' } },
  ],
});
write('version.json', {
  protocol: 'wevir-content/1',
  artifactRevision: 1,
  status: 'proposed',
  hostProtocol: PROTOCOL_VERSION,
  cloudProtocol: 'wevir-sync/1',
  schemas: Object.keys(SYNC_CONTENT_SCHEMAS),
  semanticChecks: [
    'Validate source Host/device binding and immutable resource/project binding.',
    'Validate decrypted pack references against the gateway manifest before applying.',
    'Use source stream sequence for provenance; local seq is a cursor and reference mapping.',
    'Keep concurrent heads and unresolvable references; never execute imported history.',
    'Enforce safe paths, symlinks, case collisions, aggregate bundle size and immutable chunk references.',
    'Do not install or trust synchronized scripts or enable privileged/paid preferences.',
  ],
  cryptoVectors: '../../wevir-sync/v1/crypto-vectors.json',
});
