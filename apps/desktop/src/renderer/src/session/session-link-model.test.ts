import type { Session, Workspace } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  findSession,
  reportBody,
  sessionHrefId,
  sessionPlace,
  sessionStatus,
} from './session-link-model';

const NOW = '2026-10-27T00:00:00.000Z';

const workspace: Workspace = {
  id: 'ws_a',
  rootPath: '/tmp/a',
  displayName: 'wevir',
  createdAt: NOW,
  updatedAt: NOW,
};

function session(extra: Partial<Session> = {}): Session {
  return {
    id: 'ses_1',
    workspaceId: 'ws_a',
    cwd: '/tmp/a',
    engine: { kind: 'dsh', sessionId: 'ses_1' },
    providerId: 'mock',
    modelId: 'mock-model',
    title: '修复登录',
    titleSource: 'first_prompt',
    state: 'idle',
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 1,
    ...extra,
  } satisfies Session;
}

describe('会话链接', () => {
  it('认 wevir://session/<id> 与 #<id>，别的不认', () => {
    expect(sessionHrefId('wevir://session/ses_ab12')).toBe('ses_ab12');
    expect(sessionHrefId(' #ses_ab12 ')).toBe('ses_ab12');
    expect(sessionHrefId('#section')).toBeUndefined();
    expect(sessionHrefId('wevir://session/ws_ab12')).toBeUndefined();
    expect(sessionHrefId('https://example.com/#ses_ab12')).toBeUndefined();
  });

  it('在工作台里找会话与它的项目；没载入或不存在时 undefined', () => {
    const data = {
      status: 'ready' as const,
      workspaces: [{ workspace, sessions: [session()] }],
      providers: [],
    };
    expect(findSession(data, 'ses_1')?.workspace.displayName).toBe('wevir');
    expect(findSession(data, 'ses_2')).toBeUndefined();
    expect(findSession({ status: 'loading' }, 'ses_1')).toBeUndefined();
  });

  it('卡片状态：运行中、待审批、出错，其余空闲；对话工作区写“对话”', () => {
    expect(sessionStatus(session({ state: 'running' })).tone).toBe('accent');
    expect(sessionStatus(session({ state: 'awaiting_approval' })).tone).toBe('warning');
    expect(sessionStatus(session({ state: 'error' })).tone).toBe('danger');
    expect(sessionStatus(session()).label).toBe('空闲');
    expect(sessionPlace({ ...workspace, kind: 'chats' })).toBe('对话');
  });

  it('回报只显示那个会话的回答；没有回答时是错误；认不出的原样', () => {
    const tail = '\n\nRead the whole conversation with wevir_session_read if you need more.';
    expect(
      reportBody(
        `Session ses_ab "修复登录" finished a turn you asked for (completed).\nIts final answer:\n\n改好了。\n\n测试通过。${tail}`,
      ),
    ).toBe('改好了。\n\n测试通过。');
    expect(
      reportBody(
        `Session ses_ab finished a turn you asked for (failed).\nError: 额度用完\nIt gave no final answer.${tail}`,
      ),
    ).toBe('额度用完');
    expect(reportBody('别的文字')).toBe('别的文字');
  });
});
