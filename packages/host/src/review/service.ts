// SPDX-License-Identifier: MIT
// `fenceFor` / `fenceLanguage` 移植自 pingdotgg/t3code apps/web/src/reviewCommentContext.ts（formatReviewCommentFence、
// inferReviewCommentFenceLanguage）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：拆成两个小函数；其余（存储、定位、发送）是 Wevir 自己的。
//
// 行级批注（0.67.0，`review.*`，ADR-0009）：批注存在 Host 的库里，按目录（仓库或会话的 worktree）分组。写批注时 Host 自己从那一侧
// 读出那几行作为原文，之后每次读批注都按原文现算位置（anchor.ts）。发送时把一组批注拼成一条用户消息（prompts/review-comments.md），
// 经 SessionManager.send 发给指定的会话，再标为已发送。只是本地反馈，不碰 GitHub。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ClientIdentity,
  type DiffSource,
  type MethodParams,
  type MethodResult,
  REVIEW_COMMENT_MAX_LINES,
  REVIEW_COMMENTS_MAX_PER_DIRECTORY,
  REVIEW_SNIPPET_MAX_LENGTH,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewCommentId,
  type ReviewSide,
  type SessionId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { ReviewCommentRecord, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { isSafeRelativePath, readDiffFile, repoInfo } from '../git-diff.js';
import { newId } from '../ids.js';
import { defaultPromptsDir } from '../title.js';
import { captureRange, locate, splitLines } from './anchor.js';

/** 拼好的消息最多这么长；超过时让用户少选几条。 */
export const REVIEW_MESSAGE_MAX_LENGTH = 200_000;

/** 读 `review-comments.md`：删掉注释与开头的空行；只能有 `count`、`directory`、`version`、`comments` 四个变量。 */
export function loadReviewTemplate(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'review-comments.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  const rest = text.replace(/\{\{\s*(count|directory|version|comments)\s*\}\}/g, '');
  if (rest.includes('{{')) {
    throw new Error('review-comments.md 里有不认识的变量（prompts/README.md 模板语法）');
  }
  return text;
}

export interface ReviewServiceOptions {
  storage: Storage;
  sessions: {
    send(
      params: MethodParams<'session.send'>,
      sentBy: ClientIdentity,
    ): Promise<MethodResult<'session.send'>>;
  };
  /** 消息模板；省略时读仓库里的 `prompts/review-comments.md`。 */
  template?: string;
}

/** 批注所在的目录（realpath）与它属于的工作区。 */
export interface ReviewDirectory {
  workspaceId: WorkspaceId;
  dir: string;
}

export interface ReviewAddInput {
  sessionId?: SessionId;
  source: DiffSource;
  base: string;
  head?: string;
  path: string;
  previousPath?: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  body: string;
}

export class ReviewService {
  readonly #storage: Storage;
  readonly #sessions: ReviewServiceOptions['sessions'];
  readonly #template: string;

  constructor(options: ReviewServiceOptions) {
    this.#storage = options.storage;
    this.#sessions = options.sessions;
    this.#template = options.template ?? loadReviewTemplate();
  }

  async list(where: ReviewDirectory, status?: 'pending' | 'sent'): Promise<ReviewComment[]> {
    const records = this.#storage.reviewComments
      .listByDir(where.dir, status)
      .filter((record) => record.workspaceId === where.workspaceId);
    return this.#resolve(where.dir, records);
  }

  async add(where: ReviewDirectory, input: ReviewAddInput): Promise<ReviewComment> {
    for (const [key, value] of [
      ['path', input.path],
      ['previousPath', input.previousPath],
    ] as const) {
      if (value !== undefined && !isSafeRelativePath(value)) {
        throw invalid([key], `${key} must be a relative path inside the directory`);
      }
    }
    if (input.endLine < input.startLine) {
      throw invalid(['endLine'], 'endLine is before startLine');
    }
    if (input.endLine - input.startLine + 1 > REVIEW_COMMENT_MAX_LINES) {
      throw invalid(['endLine'], `a comment covers at most ${REVIEW_COMMENT_MAX_LINES} lines`);
    }
    if (this.#storage.reviewComments.countByDir(where.dir) >= REVIEW_COMMENTS_MAX_PER_DIRECTORY) {
      throw invalid([], `at most ${REVIEW_COMMENTS_MAX_PER_DIRECTORY} comments per directory`);
    }
    const content = await readSide(where.dir, input.side, {
      base: input.base,
      ...(input.head !== undefined && { head: input.head }),
      path: input.path,
      ...(input.previousPath !== undefined && { previousPath: input.previousPath }),
    });
    if ('unavailable' in content) {
      throw invalid(
        ['path'],
        `cannot read the ${input.side} side of ${input.path}: ${content.unavailable}`,
      );
    }
    const range = captureRange(splitLines(content.text), input.startLine, input.endLine);
    if (!range) throw invalid(['startLine'], 'the lines are outside the file');
    if (range.snippet.length > REVIEW_SNIPPET_MAX_LENGTH) {
      throw invalid(['endLine'], 'the selected lines are too long');
    }
    const repo = await repoInfo(where.dir);
    const now = new Date().toISOString();
    const record: ReviewCommentRecord = {
      id: newId('rvc'),
      workspaceId: where.workspaceId,
      dir: where.dir,
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      path: input.path,
      ...(input.previousPath !== undefined && { previousPath: input.previousPath }),
      side: input.side,
      startLine: input.startLine,
      endLine: input.endLine,
      source: input.source,
      base: input.base,
      ...(input.head !== undefined && { head: input.head }),
      ...(repo?.branch !== undefined && { branch: repo.branch }),
      ...range,
      body: input.body.trim(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.#storage.reviewComments.insert(record);
    return toComment(record, {
      state: 'current',
      startLine: record.startLine,
      endLine: record.endLine,
    });
  }

  async update(commentId: ReviewCommentId, body: string): Promise<ReviewComment> {
    const record = this.#get(commentId, ['commentId']);
    if (record.status !== 'pending') throw invalid(['commentId'], 'the comment was already sent');
    this.#storage.reviewComments.setBody(commentId, body.trim(), new Date().toISOString());
    const [comment] = await this.#resolve(record.dir, [this.#get(commentId, ['commentId'])]);
    return comment as ReviewComment;
  }

  remove(commentIds: readonly ReviewCommentId[]): number {
    return this.#storage.transaction(() =>
      commentIds.reduce(
        (count, id) => count + (this.#storage.reviewComments.remove(id) ? 1 : 0),
        0,
      ),
    );
  }

  /** 把目录里这几条还没发的批注拼成一条消息发给 `targetSessionId`，之后标为已发送。 */
  async send(
    where: ReviewDirectory,
    params: {
      commentIds: readonly ReviewCommentId[];
      targetSessionId: SessionId;
      delivery?: 'steer' | 'queue';
      clientMessageId?: string;
    },
    client: ClientIdentity,
  ): Promise<MethodResult<'review.send'>> {
    const target = this.#storage.sessions.get(params.targetSessionId);
    if (!target || target.workspaceId !== where.workspaceId) {
      throw new HostError('SESSION_NOT_FOUND', `session ${params.targetSessionId} not found`);
    }
    const records = [...new Set(params.commentIds)].map((id) => {
      const record = this.#get(id, ['commentIds']);
      if (record.dir !== where.dir || record.workspaceId !== where.workspaceId) {
        throw invalid(['commentIds'], `comment ${id} belongs to another directory`);
      }
      if (record.status !== 'pending')
        throw invalid(['commentIds'], `comment ${id} was already sent`);
      return record;
    });
    const comments = await this.#resolve(where.dir, records);
    const repo = await repoInfo(where.dir);
    const text = renderReviewMessage(this.#template, {
      directory: where.dir,
      version: describeVersion(repo),
      comments,
    });
    if (text.length > REVIEW_MESSAGE_MAX_LENGTH) {
      throw invalid(['commentIds'], 'the comments are too long for one message; send fewer');
    }
    const result = await this.#sessions.send(
      {
        sessionId: params.targetSessionId,
        content: [{ type: 'text', text }],
        ...(params.delivery !== undefined && { delivery: params.delivery }),
        ...(params.clientMessageId !== undefined && { clientMessageId: params.clientMessageId }),
      },
      client,
    );
    const sent = {
      sessionId: params.targetSessionId,
      at: new Date().toISOString(),
      ...(result.turnId !== undefined && { turnId: result.turnId }),
      ...(result.pendingId !== undefined && { pendingId: result.pendingId }),
    };
    this.#storage.transaction(() => {
      for (const record of records) this.#storage.reviewComments.markSent(record.id, sent);
    });
    return {
      comments: comments.map((comment) => ({
        ...comment,
        status: 'sent' as const,
        sent,
        updatedAt: sent.at,
      })),
      ...(result.turnId !== undefined && { turnId: result.turnId }),
      ...(result.pendingId !== undefined && { pendingId: result.pendingId }),
      seq: result.seq,
    };
  }

  #get(id: ReviewCommentId, path: string[]): ReviewCommentRecord {
    const record = this.#storage.reviewComments.get(id);
    if (!record) throw invalid(path, `comment ${id} not found`);
    return record;
  }

  /** 现算每条批注的位置：同一侧同一文件只读一次。 */
  async #resolve(dir: string, records: readonly ReviewCommentRecord[]): Promise<ReviewComment[]> {
    const reads = new Map<string, Promise<string[] | { unavailable: string }>>();
    const linesOf = (record: ReviewCommentRecord) => {
      const side = record.side as ReviewSide;
      const key =
        side === 'new'
          ? `disk\0${record.path}`
          : `${record.base}\0${record.previousPath ?? record.path}`;
      let read = reads.get(key);
      if (!read) {
        // `new` 一侧对着磁盘上现在的文件定位；`old` 一侧读基线提交，不会变。
        read = readSide(dir, side, {
          base: record.base,
          path: record.path,
          ...(record.previousPath !== undefined && { previousPath: record.previousPath }),
        }).then((content) => ('unavailable' in content ? content : splitLines(content.text)));
        reads.set(key, read);
      }
      return read;
    };
    return Promise.all(
      records.map(async (record) => {
        const lines = await linesOf(record);
        const anchor: ReviewAnchor =
          'unavailable' in lines
            ? {
                state: 'outdated',
                reason: lines.unavailable === 'not_found' ? 'file_missing' : 'unreadable',
              }
            : locate(lines, record);
        return toComment(record, anchor);
      }),
    );
  }
}

/** 读一侧的全文：`old` 读基线提交，`new` 读回合后快照或磁盘。读不了时是原因（`not_found`、`too_large`、`binary`、`not_repo`）。 */
async function readSide(
  dir: string,
  side: ReviewSide,
  where: { base: string; head?: string; path: string; previousPath?: string },
): Promise<{ text: string } | { unavailable: string }> {
  const result =
    side === 'old'
      ? await readDiffFile(dir, { oldRev: where.base, oldPath: where.previousPath ?? where.path })
      : await readDiffFile(dir, {
          ...(where.head !== undefined && { newRev: where.head }),
          newPath: where.path,
        });
  if (!result) return { unavailable: 'not_repo' };
  if (result.unavailable !== undefined) return { unavailable: result.unavailable };
  return { text: (side === 'old' ? result.oldContents : result.newContents) ?? '' };
}

function toComment(record: ReviewCommentRecord, anchor: ReviewAnchor): ReviewComment {
  return {
    id: record.id as ReviewCommentId,
    workspaceId: record.workspaceId as WorkspaceId,
    ...(record.sessionId !== undefined && { sessionId: record.sessionId as SessionId }),
    path: record.path,
    ...(record.previousPath !== undefined && { previousPath: record.previousPath }),
    side: record.side as ReviewSide,
    startLine: record.startLine,
    endLine: record.endLine,
    source: record.source as DiffSource,
    base: record.base,
    ...(record.head !== undefined && { head: record.head }),
    ...(record.branch !== undefined && { branch: record.branch }),
    snippet: record.snippet,
    body: record.body,
    status: record.status === 'sent' ? 'sent' : 'pending',
    ...(record.sent !== undefined && {
      sent: record.sent as NonNullable<ReviewComment['sent']>,
    }),
    anchor,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function invalid(path: (string | number)[], message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

// ── 消息 ─────────────────────────────────────────────────────────

/** 批注针对的版本，写进消息：分支与 HEAD 的短 SHA。 */
export function describeVersion(repo: { head?: string; branch?: string } | undefined): string {
  if (!repo) return '不在 git 仓库里';
  if (repo.head === undefined)
    return repo.branch ? `分支 ${repo.branch}，还没有提交` : '还没有提交';
  const short = repo.head.slice(0, 7);
  return repo.branch ? `分支 ${repo.branch}，HEAD ${short}` : `HEAD ${short}（分离头指针）`;
}

const OUTDATED_REASONS: Record<string, string> = {
  changed: '文件已改，找不到这几行',
  ambiguous: '文件已改，这几行出现不止一处',
  file_missing: '文件已不存在',
  unreadable: '文件无法读取',
};

function lineRange(start: number, end: number): string {
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/** 一条批注在消息里的位置说明。 */
export function describeLocation(comment: ReviewComment): string {
  const original = lineRange(comment.startLine, comment.endLine);
  if (comment.side === 'old') return `改动前的${original}（基线 ${comment.base.slice(0, 7)}）`;
  const { anchor } = comment;
  if (anchor.state === 'outdated') {
    return `原${original}（已过期：${OUTDATED_REASONS[anchor.reason ?? ''] ?? '文件已改'}）`;
  }
  const now = lineRange(anchor.startLine ?? comment.startLine, anchor.endLine ?? comment.endLine);
  return anchor.state === 'relocated'
    ? `${now}（当前文件；写批注时在${original}）`
    : `${now}（当前文件）`;
}

/** 把一组批注拼成发给 Agent 的消息：先替换模板里的变量，再放进批注（批注里出现 `{{` 不会被当成变量）。 */
export function renderReviewMessage(
  template: string,
  input: { directory: string; version: string; comments: readonly ReviewComment[] },
): string {
  const blocks = input.comments.map((comment, index) => {
    const renamed = comment.previousPath !== undefined ? `（原 ${comment.previousPath}）` : '';
    const fence = fenceFor(comment.snippet);
    return [
      `### ${index + 1}. ${comment.path}${renamed}，${describeLocation(comment)}`,
      '',
      `${fence}${fenceLanguage(comment.path)}`,
      comment.snippet,
      fence,
      '',
      `意见：${comment.body}`,
    ].join('\n');
  });
  const [head, tail = ''] = template
    .replace(/\{\{\s*count\s*\}\}/g, String(input.comments.length))
    .replace(/\{\{\s*directory\s*\}\}/g, input.directory)
    .replace(/\{\{\s*version\s*\}\}/g, input.version)
    .split(/\{\{\s*comments\s*\}\}/);
  return `${head ?? ''}${blocks.join('\n\n')}${tail}`.trim();
}

/** 代码块的围栏：比片段里最长的一串反引号多一个，至少三个。（T3 formatReviewCommentFence） */
export function fenceFor(contents: string): string {
  const longest = Math.max(0, ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 代码块的语言：文件的扩展名，没有时 `text`。（T3 inferReviewCommentFenceLanguage） */
export function fenceLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1);
  if (name.startsWith('.') && name.length > 1) return name.slice(1);
  return 'text';
}
