import type { WevirClient } from '@wevir/client-sdk';
import type {
  AccountState,
  ImportSessionCandidate,
  ProviderProfile,
  Session,
} from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEntry } from '@/data/workbench-model';
import {
  historiesForProject,
  historyProjects,
  importHistory,
  latestProject,
  needsWelcome,
  welcomeProviders,
} from './welcome-model';

const entry: WorkspaceEntry = {
  workspace: {
    id: 'ws_demo',
    rootPath: '/project',
    displayName: 'Demo',
    createdAt: '',
    updatedAt: '',
  },
  sessions: [],
};
const candidate: ImportSessionCandidate = {
  key: 'session:one',
  path: '/external/log.jsonl',
  app: 'claude',
  externalId: 'one',
  title: 'Task',
  project: '/project',
  startedAt: '',
  updatedAt: '',
  turns: 2,
  skipped: 0,
  status: 'new',
  recommended: false,
};

describe('first-use selection', () => {
  it('keeps completion and existing projects or chats out of the welcome flow', () => {
    expect(needsWelcome(false, [])).toBe(true);
    expect(needsWelcome(true, [])).toBe(false);
    expect(needsWelcome(false, [entry])).toBe(false);
    const chats = { ...entry, workspace: { ...entry.workspace, kind: 'chats' as const } };
    expect(needsWelcome(false, [chats])).toBe(true);
    expect(needsWelcome(false, [{ ...chats, sessions: [{} as Session] }])).toBe(false);
  });

  it('prefers signed-in installed subscriptions without a key and excludes unavailable sources', () => {
    const provider = (id: string, kind: ProviderProfile['kind'], hasSecret = false) =>
      ({ id, kind, hasSecret, enabled: true }) as ProviderProfile;
    const providers = [
      provider('api', 'openai-compatible', true),
      provider('claude', 'claude'),
      provider('chatgpt', 'chatgpt'),
      provider('missing', 'claude'),
      provider('local', 'openai-compatible'),
      { ...provider('disabled', 'openai-compatible', true), enabled: false },
    ];
    const accounts = [
      { id: 'claude', kind: 'claude', status: 'signed_in' },
      { id: 'chatgpt', kind: 'chatgpt', status: 'signed_out' },
      { id: 'missing', kind: 'claude', status: 'signed_in', installed: false },
    ] as AccountState[];
    expect(welcomeProviders(providers, accounts).map((item) => item.id)).toEqual([
      'claude',
      'api',
      'local',
    ]);
    expect(welcomeProviders(providers, undefined).map((item) => item.id)).toEqual(['api', 'local']);
  });

  it('groups only the chosen project and omits duplicate imported histories', () => {
    const other = { ...candidate, key: 'other', project: '/other' };
    expect(historiesForProject([candidate, other], '/project', entry)).toEqual([candidate]);
    const imported = {
      origin: {
        kind: 'imported',
        app: 'claude',
        path: candidate.path,
        externalId: candidate.externalId,
      },
    } as Session;
    expect(
      historiesForProject([candidate], '/project', { ...entry, sessions: [imported] }),
    ).toEqual([]);
    expect(historyProjects([entry], [candidate, other, other])).toEqual([
      { value: '/project', label: 'Demo' },
      { value: '/other', label: '/other' },
    ]);
  });

  it('lands on the project of the most recent readable history', () => {
    const at = (key: string, project: string | undefined, updatedAt: string, problem?: string) =>
      ({ ...candidate, key, project, updatedAt, problem }) as ImportSessionCandidate;
    expect(
      latestProject([
        at('a', '/a', '2026-11-01T00:00:00Z'),
        at('b', '/b', '2026-11-03T00:00:00Z'),
        at('c', '/c', '2026-11-05T00:00:00Z', 'unreadable'),
        at('d', undefined, '2026-11-06T00:00:00Z'),
      ]),
    ).toBe('/b');
    expect(latestProject([])).toBeUndefined();
  });

  it.each(['imported', 'skipped'])(
    'opens one explicitly selected history on %s without bulk import or a model message',
    async (outcome) => {
      const session = { id: 'ses_imported', readOnly: { reason: 'imported' } };
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          results: [{ key: candidate.key, outcome, sessionId: session.id }],
        })
        .mockResolvedValueOnce({ session });
      expect(await importHistory({ request } as unknown as WevirClient, candidate)).toEqual(
        session,
      );
      expect(request.mock.calls).toEqual([
        ['import.apply', { app: 'claude', items: [{ key: candidate.key }] }],
        ['session.get', { sessionId: session.id }],
      ]);
    },
  );

  it('does not open a failed import', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ results: [{ outcome: 'failed', reason: 'not_found' }] });
    await expect(importHistory({ request } as unknown as WevirClient, candidate)).rejects.toThrow(
      'not_found',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
