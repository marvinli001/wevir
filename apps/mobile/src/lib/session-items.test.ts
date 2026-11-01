import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import type { MessageFrom, PendingMessage, SessionId } from '@wevir/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { type SessionItemLabels, sessionItems } from './session-items';

const OWN = 'ses_own' as SessionId;
const OTHER = 'ses_other' as SessionId;

const LABELS: SessionItemLabels = {
  image: '图片',
  tool: () => undefined,
  sessionTitle: (id) => (id === OTHER ? '修登录页' : undefined),
};

function user(id: string, text: string, from?: MessageFrom): ChatMessage {
  return {
    role: 'user',
    id,
    turnId: 'trn_1',
    parts: [{ type: 'text', key: `${id}:t`, text }],
    ...(from !== undefined && { from }),
  } as unknown as ChatMessage;
}

function transcript(
  messages: ChatMessage[],
  pendingMessages: Partial<PendingMessage>[] = [],
): Transcript {
  return {
    sessionId: OWN,
    messages,
    pendingApprovals: [],
    pendingQuestions: [],
    pendingMessages,
  } as unknown as Transcript;
}

beforeAll(() => setLocale('zh-CN'));

describe('sessionItems：不是用户写的消息', () => {
  it('后台进程的通知是一行标记，不是用户的气泡', () => {
    const text = '[Wevir] Background process p16 "server" exited with code 0 after 1m 40s.';
    const items = sessionItems(
      transcript([
        user('m1', text, {
          sessionId: OWN,
          kind: 'report',
          process: { id: 'p16', name: 'server', event: 'exit', exitCode: 0 },
        }),
      ]),
      LABELS,
    );
    expect(items).toEqual([
      {
        kind: 'notice',
        key: 'm1',
        icon: 'process',
        label: '后台进程“server”已退出（退出码 0）',
        text,
      },
    ]);
  });

  it('别的会话发来的消息与回报是卡片，回报只留那个会话的回答', () => {
    const report =
      'Session ses_other "修登录页" finished a turn you asked for (completed).\nIts final answer:\n\n改好了。' +
      '\n\nRead the whole conversation with wevir_session_read if you need more.';
    const items = sessionItems(
      transcript([
        user('m1', '帮我看看日志', { sessionId: OTHER, kind: 'message' }),
        user('m2', report, { sessionId: OTHER, kind: 'report' }),
        user('m3', report, { sessionId: OWN, kind: 'report' }),
      ]),
      LABELS,
    );
    expect(items).toEqual([
      {
        kind: 'relayed',
        key: 'm1',
        icon: 'message',
        label: '来自另一个会话的消息',
        source: '修登录页',
        text: '帮我看看日志',
      },
      {
        kind: 'relayed',
        key: 'm2',
        icon: 'report',
        label: '“修登录页”的回报',
        source: '修登录页',
        text: '改好了。',
      },
      { kind: 'relayed', key: 'm3', icon: 'report', label: '子会话的回报', text: '改好了。' },
    ]);
  });

  it('自动修复与第二意见是一行标记，第二意见的附言照常是气泡；额度恢复后的继续消息不显示', () => {
    const items = sessionItems(
      transcript([
        user('m1', 'checks failed', {
          sessionId: OWN,
          kind: 'report',
          repair: { attempt: 1, maxAttempts: 2 } as NonNullable<MessageFrom['repair']>,
        }),
        user('m2', '看看这个意见\n\nopinion', {
          sessionId: OTHER,
          kind: 'report',
          opinion: { opinionId: 'opn_1', note: '看看这个意见' } as NonNullable<
            MessageFrom['opinion']
          >,
        }),
        user('m3', 'continue', {
          sessionId: OWN,
          kind: 'report',
          usageLimit: { turnId: 'trn_0' } as NonNullable<MessageFrom['usageLimit']>,
        }),
      ]),
      LABELS,
    );
    expect(items.map((item) => [item.kind, 'label' in item ? item.label : item.key])).toEqual([
      ['notice', '自动修复 · 第 1/2 次'],
      ['user', 'm2:note'],
      ['notice', '第二意见'],
    ]);
  });

  it('待送达的通知只显示一行说明', () => {
    const items = sessionItems(
      transcript(
        [],
        [
          {
            id: 'pm_1',
            status: 'waiting',
            delivery: 'queue',
            content: [{ type: 'text', text: '[Wevir] Background process p2 printed 1 line' }],
            from: {
              sessionId: OWN,
              kind: 'report',
              process: { id: 'p2', name: 'tests', event: 'match' },
            },
          } as unknown as Partial<PendingMessage>,
          {
            id: 'pm_2',
            status: 'waiting',
            delivery: 'steer',
            content: [{ type: 'text', text: '顺便改标题' }],
          } as unknown as Partial<PendingMessage>,
        ],
      ),
      LABELS,
    );
    expect(items).toMatchObject([
      {
        kind: 'pending',
        pendingId: 'pm_1',
        notice: { icon: 'process', label: '后台进程“tests”输出匹配' },
      },
      { kind: 'pending', pendingId: 'pm_2', text: '顺便改标题' },
    ]);
    expect(items[1]).not.toHaveProperty('notice');
  });
});
