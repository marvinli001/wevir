import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type {
  ImportApp,
  ImportApplyResultItem,
  ImportScanResult,
  ImportSessionCandidate,
  SessionId,
  TurnId,
  WevirEvent,
  WorkspaceId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { AppendInput, EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import { truncateJson, truncateToolOutput } from '../truncate.js';
import { parseClaudeSession } from './claude-session.js';
import { parseCodexSession } from './codex-session.js';
import { draftKey, matchProject } from './common.js';
import type { ExternalSessionInfo, ExternalSessionItem, SessionParser } from './session-jsonl.js';

export interface SessionDraft extends ExternalSessionInfo {
  problem?: string;
  app: 'claude' | 'codex';
  key: string;
  path: string;
}

const PARSERS = { claude: parseClaudeSession, codex: parseCodexSession };

type SessionIssues = NonNullable<ImportScanResult['sessionIssues']>;

async function* files(root: string, depth: number, issues: SessionIssues): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') issues.push({ path: root, reason: 'unreadable' });
      return [];
    },
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0) yield* files(path, depth - 1, issues);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

export async function scanSessions(
  app: ImportApp,
  home: string,
): Promise<{ sessions: SessionDraft[]; sessionIssues: SessionIssues }> {
  const sessionIssues: SessionIssues = [];
  const drafts: SessionDraft[] = [];
  if (app !== 'claude' && app !== 'codex') return { sessions: drafts, sessionIssues };
  for await (const path of files(
    join(home, app === 'claude' ? 'projects' : 'sessions'),
    app === 'claude' ? 1 : 4,
    sessionIssues,
  )) {
    if (app === 'codex' && !basename(path).startsWith('rollout-')) continue;
    try {
      const info = await PARSERS[app](path);
      if (info === undefined || !isAbsolute(info.project)) {
        sessionIssues.push({ path, reason: 'invalid' });
        continue;
      }
      drafts.push({ ...info, app, path, key: draftKey('session', path, info.externalId) });
    } catch {
      sessionIssues.push({ path, reason: 'unreadable' });
    }
  }
  return {
    sessionIssues,
    sessions: drafts.sort(
      (a, b) => a.project.localeCompare(b.project) || b.updatedAt.localeCompare(a.updatedAt),
    ),
  };
}

export class SessionImports {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: Storage,
    private events: EventStore,
  ) {}

  candidate(draft: SessionDraft): ImportSessionCandidate {
    const existing = this.storage.sessions.getByEngineSessionId('imported', draft.key);
    const matched = matchProject(
      this.storage.workspaces.list().map((w) => ({
        id: w.id as WorkspaceId,
        folders: [w.rootPath, ...(w.extraFolders ?? [])],
      })),
      draft.project,
    );
    return {
      key: draft.key,
      path: draft.path,
      app: draft.app,
      externalId: draft.externalId,
      title: draft.title,
      project: draft.project,
      startedAt: draft.startedAt,
      updatedAt: draft.updatedAt,
      turns: draft.turns,
      skipped: draft.skipped,
      status: existing === undefined ? 'new' : 'same',
      recommended: false,
      ...(matched !== undefined && { workspaceId: matched.workspaceId }),
    };
  }

  apply(draft: SessionDraft): Promise<ImportApplyResultItem> {
    const run = this.#tail.then(() => this.#apply(draft));
    this.#tail = run.catch(() => {});
    return run;
  }

  async #apply(draft: SessionDraft): Promise<ImportApplyResultItem> {
    const prior = this.storage.sessions.getByEngineSessionId('imported', draft.key);
    const result = (sessionId: string, outcome: 'imported' | 'skipped'): ImportApplyResultItem => ({
      key: draft.key,
      kind: 'session',
      name: draft.title || draft.externalId,
      outcome,
      sessionId: sessionId as SessionId,
      skipped: draft.skipped,
    });
    if (prior !== undefined) return result(prior.id, 'skipped');
    // Recheck the file boundary immediately before importing; symlinks are never followed.
    if (!(await lstat(draft.path)).isFile()) throw new Error('invalid source');
    const project = await realpath(draft.project).catch(() => draft.project);
    let workspace = this.storage.workspaces
      .list({ includeRemoved: true })
      .find((w) => w.rootPath === project || w.extraFolders?.includes(project));
    const now = new Date().toISOString();
    if (workspace === undefined) {
      workspace = {
        id: newId('ws'),
        rootPath: project,
        displayName: basename(project) || project,
        createdAt: now,
        updatedAt: now,
      };
      this.storage.workspaces.insert(workspace);
    } else if (workspace.removedAt !== undefined)
      this.storage.workspaces.restore(workspace.id, now);
    const id = newId('ses');
    const origin = {
      kind: 'imported' as const,
      app: draft.app,
      externalId: draft.externalId,
      path: draft.path,
      skipped: draft.skipped,
      nativeCompatible: draft.nativeCompatible,
    };
    const providerId = draft.app === 'claude' ? 'claude' : 'chatgpt';
    this.storage.sessions.insert({
      id,
      workspaceId: workspace.id,
      cwd: project,
      engine: 'imported',
      engineSessionId: draft.key,
      providerId,
      modelId: draft.modelId ?? 'unknown',
      origin,
      title: draft.title,
      titleSource: 'first_prompt',
      state: 'closed',
      lastSeq: 0,
      createdAt: draft.startedAt,
      updatedAt: draft.updatedAt,
    });
    try {
      this.events.append(id, {
        type: 'session.created',
        source: 'host',
        payload: {
          workspaceId: workspace.id as WorkspaceId,
          cwd: project,
          providerId,
          modelId: draft.modelId ?? 'unknown',
          origin,
        },
      });
      let batch: WevirEvent[] = [];
      const push = (input: AppendInput, at: string) => {
        batch.push({ ...input, sessionId: id, seq: 1, ts: at } as WevirEvent);
        if (batch.length >= 256) {
          this.events.appendHistory(id, batch, true);
          batch = [];
        }
      };
      const convert = new SessionEvents(push);
      const parsed = await (PARSERS[draft.app] as SessionParser)(draft.path, (item) =>
        convert.accept(item),
      );
      if (
        parsed === undefined ||
        parsed.externalId !== draft.externalId ||
        parsed.project !== draft.project
      )
        throw new Error('source changed');
      convert.finish(parsed.updatedAt, true);
      push(
        {
          type: 'session.state_changed',
          source: 'host',
          payload: { from: 'idle', to: 'closed', reason: 'closed' },
        },
        parsed.updatedAt,
      );
      push(
        {
          type: 'session.title_changed',
          source: 'host',
          payload: { title: parsed.title, source: 'first_prompt' },
        },
        parsed.updatedAt,
      );
      push(
        { type: 'session.read_only', source: 'host', payload: { reason: 'imported', message: '' } },
        parsed.updatedAt,
      );
      this.events.appendHistory(id, batch, true);
      return { ...result(id, 'imported'), skipped: parsed.skipped };
    } catch (error) {
      this.storage.sessions.remove([id]);
      this.events.forget([id]);
      throw error;
    }
  }
}

class SessionEvents {
  #turn: TurnId | undefined;
  #started = '';
  #lastAt: string | undefined;
  #tools = new Set<string>();
  constructor(private push: (input: AppendInput, at: string) => void) {}

  accept(item: ExternalSessionItem): void {
    const { at } = item;
    if (item.kind === 'end') {
      this.#lastAt = at;
      this.finish(at, item.interrupted === true);
      return;
    }
    if (item.kind === 'user') this.finish(at, false);
    if (this.#turn === undefined) {
      this.#turn = newId('trn');
      this.#started = at;
      if (item.kind === 'user')
        this.push(
          {
            type: 'user.message',
            source: 'host',
            payload: {
              turnId: this.#turn,
              content: [{ type: 'text', text: item.text }],
              sentBy: {
                deviceId: 'external-import',
                clientId: 'external-import',
                clientKind: 'desktop',
              },
            },
          },
          at,
        );
      this.push({ type: 'turn.started', source: 'engine', payload: { turnId: this.#turn } }, at);
    }
    const turnId = this.#turn;
    this.#lastAt = at;
    if (item.kind === 'assistant')
      this.push(
        {
          type: 'assistant.message',
          source: 'engine',
          payload: {
            turnId,
            messageId: item.id ?? newId('trn'),
            text: item.text,
            replaces: [],
          },
        },
        at,
      );
    if (item.kind === 'tool') {
      this.#tools.add(item.id);
      this.push(
        {
          type: 'tool.started',
          source: 'engine',
          payload: {
            turnId,
            toolCallId: item.id,
            toolName: item.name,
            display: item.display,
            input: truncateJson(item.input),
          },
        },
        at,
      );
    }
    if (item.kind === 'result' && this.#tools.delete(item.id))
      this.push(
        {
          type: 'tool.finished',
          source: 'engine',
          payload: {
            turnId,
            toolCallId: item.id,
            status: item.failed ? 'failed' : 'completed',
            output: truncateToolOutput({ text: item.text, truncated: false }),
          },
        },
        at,
      );
  }

  finish(at: string, interrupted: boolean): void {
    if (this.#turn === undefined) return;
    at = this.#lastAt ?? at;
    for (const id of this.#tools)
      this.push(
        {
          type: 'tool.finished',
          source: 'host',
          payload: {
            turnId: this.#turn,
            toolCallId: id,
            status: 'unknown',
          },
        },
        at,
      );
    this.#tools.clear();
    this.push(
      {
        type: 'turn.finished',
        source: 'host',
        payload: {
          turnId: this.#turn,
          outcome: interrupted ? 'interrupted' : 'completed',
          durationMs: Math.max(0, Date.parse(at) - Date.parse(this.#started)),
        },
      },
      at,
    );
    this.#turn = undefined;
    this.#lastAt = undefined;
  }
}
