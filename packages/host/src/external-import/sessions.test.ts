import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { parseClaudeSession } from './claude-session.js';
import { parseCodexSession } from './codex-session.js';
import { type ExternalSessionItem, SESSION_LINE_MAX_BYTES } from './session-jsonl.js';
import { SessionImports, scanSessions } from './sessions.js';

const temp = useTempDir();
const storages = useStorages();
export const sourceFixture = (app: 'claude' | 'codex') =>
  readFileSync(new URL(`./fixtures/${app}-session.jsonl`, import.meta.url), 'utf8');

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe.each(['claude', 'codex'] as const)('%s session parser', (app) => {
  const parser = app === 'claude' ? parseClaudeSession : parseCodexSession;
  it('reads metadata, canonical messages and shell/file operations without duplicate display events', async () => {
    const path = put(join(temp(), 'source.jsonl'), sourceFixture(app));
    const items: ExternalSessionItem[] = [];
    const info = await parser(path, (item) => {
      items.push(item);
    });
    expect(info).toMatchObject({
      title: 'Repair the counter',
      project: '/workspace/demo',
      turns: 2,
      skipped: 1,
      startedAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:01:01.000Z',
    });
    expect(items.filter((x) => x.kind === 'user')).toHaveLength(2);
    expect(items.filter((x) => x.kind === 'tool')).toMatchObject([
      { display: { kind: 'shell' } },
      { display: { kind: 'edit', paths: ['counter.ts'] } },
    ]);
    expect(items.filter((x) => x.kind === 'result')).toHaveLength(2);
  });

  it('counts malformed, unknown, oversized and truncated records and continues at the next line', async () => {
    const path = put(
      join(temp(), 'source.jsonl'),
      `${sourceFixture(app)}\nnot json\n${'x'.repeat(SESSION_LINE_MAX_BYTES + 10)}\n{}\n{"unfinished":`,
    );
    expect(await parser(path)).toMatchObject({ turns: 2, skipped: 5 });
  });

  it('streams a log larger than the normal source-file limit and accepts an unterminated valid final line', async () => {
    const path = put(join(temp(), 'source.jsonl'), sourceFixture(app));
    const row =
      app === 'claude'
        ? {
            type: 'assistant',
            timestamp: '2026-10-01T10:02:00Z',
            message: { content: [{ type: 'text', text: 'x'.repeat(256) }] },
          }
        : {
            type: 'response_item',
            timestamp: '2026-10-01T10:02:00Z',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'x'.repeat(256) }],
            },
          };
    appendFileSync(path, `\n${`${JSON.stringify(row)}\n`.repeat(20_000)}${JSON.stringify(row)}`);
    let count = 0;
    await parser(path, () => {
      count++;
    });
    expect(count).toBeGreaterThan(20_000);
    expect(await parser(path)).toMatchObject({
      turns: 2,
      skipped: 1,
      updatedAt: '2026-10-01T10:02:00.000Z',
    });
  });

  it('imports once as a read-only project session, preserves timestamps and never writes the source', async () => {
    const root = temp();
    const project = join(root, 'project');
    mkdirSync(project);
    const source = sourceFixture(app).replaceAll(
      '/workspace/demo',
      project.replaceAll('\\', '\\\\'),
    );
    const path = put(
      app === 'claude'
        ? join(root, 'external', 'projects', 'demo', 'one.jsonl')
        : join(root, 'external', 'sessions', '2026', '10', '01', 'rollout-one.jsonl'),
      source,
    );
    const storage = storages.open(join(root, 'db'));
    const events = new EventStore({ storage });
    const imports = new SessionImports(storage, events);
    const drafts = await scanSessions(app, join(root, 'external'));
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    if (!draft) throw new Error('missing fixture');
    expect(imports.candidate(draft)).not.toHaveProperty('content');
    const [one, two] = await Promise.all([imports.apply(draft), imports.apply(draft)]);
    expect([one.outcome, two.outcome]).toEqual(['imported', 'skipped']);
    expect(one.sessionId).toBe(two.sessionId);
    const session = events.snapshot(one.sessionId as never)?.session;
    expect(session).toMatchObject({
      state: 'closed',
      readOnly: { reason: 'imported' },
      origin: { kind: 'imported', path: draft.path },
      createdAt: draft.startedAt,
      updatedAt: draft.updatedAt,
    });
    const history = events.readSince(one.sessionId as never, 0);
    expect(history.filter((x) => x.type === 'user.message')).toHaveLength(2);
    expect(history.find((x) => x.type === 'turn.finished')).toMatchObject({
      ts: app === 'claude' ? '2026-10-01T10:00:04.000Z' : '2026-10-01T10:00:06.000Z',
      payload: { durationMs: app === 'claude' ? 4000 : 6000 },
    });
    expect(history.find((x) => x.type === 'assistant.message')?.ts).toMatch(/^2026-10-01T10:00:/);
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(imports.candidate(draft).status).toBe('same');
  });
});

it('marks shared-prefix Codex logs as incomplete and does not follow external history references', async () => {
  const path = put(
    join(temp(), 'source.jsonl'),
    sourceFixture('codex').replace(
      '"source":"cli"',
      '"source":"cli","history_base":{"path":"/outside/private.jsonl"}',
    ),
  );
  expect(await parseCodexSession(path)).toMatchObject({ nativeCompatible: false, skipped: 2 });
});

it('skips Claude sidechains and meta messages, and redacts secrets from text and nested tool inputs', async () => {
  const token = `sk-${'a'.repeat(40)}`;
  const path = put(
    join(temp(), 'source.jsonl'),
    sourceFixture('claude').replace('cat counter.ts', token) +
      '\n' +
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        timestamp: '2026-10-02T00:00:00Z',
        message: { content: 'side' },
      }),
  );
  const items: ExternalSessionItem[] = [];
  expect(
    await parseClaudeSession(path, (item) => {
      items.push(item);
    }),
  ).toMatchObject({ turns: 2 });
  expect(JSON.stringify(items)).not.toContain(token);
  expect(JSON.stringify(items)).toContain('[REDACTED]');
});
