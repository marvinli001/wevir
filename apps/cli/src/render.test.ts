import type {
  ApprovalId,
  ApprovalRequest,
  SessionId,
  WevirEvent,
  WevirEventPayload,
  WevirEventType,
} from '@wevir/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from './i18n/index.js';
import { EventRenderer, type Sink } from './render.js';
import { PLAIN } from './style.js';

const SES: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const APR: ApprovalId = 'apr_01JA2B3C4D5E6F7G8H9JKMNPQR';

let seq = 0;
function ev<T extends WevirEventType>(type: T, payload: WevirEventPayload<T>): WevirEvent {
  seq += 1;
  return {
    seq,
    sessionId: SES,
    ts: '2026-10-13T00:00:00.000Z',
    type,
    source: 'engine',
    payload,
  } as WevirEvent;
}

/** 记下写出的文字，`line` / `endLine` 的语义与 LineConsole 相同。 */
function stringSink(): Sink & { text: () => string } {
  let text = '';
  const atLineStart = () => text === '' || text.endsWith('\n');
  return {
    write: (t) => {
      text += t;
    },
    line: (t = '') => {
      text += `${atLineStart() ? '' : '\n'}${t}\n`;
    },
    endLine: () => {
      if (!atLineStart()) text += '\n';
    },
    text: () => text,
  };
}

function renderer(options: { decidedHere?: boolean; echoed?: string } = {}) {
  const sink = stringSink();
  const r = new EventRenderer({
    sink,
    styles: PLAIN,
    decidedHere: () => options.decidedHere ?? false,
    isEchoed: (id) => id === options.echoed,
  });
  return { r, text: sink.text };
}

const delta = (text: string, blockIndex = 0, kind: 'text' | 'reasoning' = 'text') =>
  ev('assistant.delta', { turnId: 'trn_1', streamId: 'stm_1', blockIndex, kind, text });

const approval: ApprovalRequest = {
  id: APR,
  sessionId: SES,
  turnId: 'trn_1',
  toolCallId: 'call_1',
  options: [
    { optionId: 'allow', label: 'Allow', kind: 'allow_once', category: 'allow' },
    { optionId: 'reject', label: 'Reject', kind: 'reject_once', category: 'reject' },
  ],
  detail: {
    toolName: 'write',
    display: { kind: 'write', summary: '/home/u/out/summary.md' },
    justification: '用户要求另存一份',
    sandboxPermissions: 'danger-full-access',
  },
  status: 'pending',
  createdAt: '2026-10-13T00:00:00.000Z',
};

describe('EventRenderer', () => {
  beforeEach(() => setLocale('zh'));

  it('实时：增量到达即显示，替换它们的已提交消息不再重复', () => {
    const { r, text } = renderer();
    r.caughtUp();
    r.render(delta('你好，'));
    r.render(delta('世界'));
    expect(text()).toBe('你好，世界');
    r.render(
      ev('assistant.message', {
        turnId: 'trn_1',
        messageId: 'm1',
        text: '你好，世界',
        replaces: [{ streamId: 'stm_1', blockIndex: 0 }],
      }),
    );
    r.render(
      ev('turn.finished', {
        turnId: 'trn_1',
        outcome: 'completed',
        durationMs: 1200,
      }),
    );
    expect(text()).toBe('你好，世界\n── 本轮完成 · 1.2 s ──\n');
  });

  it('没有增量旁路时显示已提交消息的全文', () => {
    const { r, text } = renderer();
    r.caughtUp();
    r.render(
      ev('assistant.message', { turnId: 'trn_1', messageId: 'm1', text: '整条消息', replaces: [] }),
    );
    expect(text()).toBe('整条消息\n');
  });

  it('回放：只显示已提交的消息，追平时补上正在生成的那一段，之后接着实时', () => {
    const { r, text } = renderer();
    r.render(ev('user.message', userMessage('第一问')));
    r.render(delta('旧回答'));
    r.render(
      ev('assistant.message', {
        turnId: 'trn_1',
        messageId: 'm1',
        text: '旧回答',
        replaces: [{ streamId: 'stm_1', blockIndex: 0 }],
      }),
    );
    r.render(
      ev('assistant.delta', {
        turnId: 'trn_2',
        streamId: 'stm_2',
        blockIndex: 0,
        kind: 'text',
        text: '正在',
      }),
    );
    expect(text()).toBe('\n› 第一问\n旧回答\n');
    r.caughtUp();
    r.render(
      ev('assistant.delta', {
        turnId: 'trn_2',
        streamId: 'stm_2',
        blockIndex: 0,
        kind: 'text',
        text: '生成',
      }),
    );
    expect(text()).toBe('\n› 第一问\n旧回答\n── 以下为实时输出 ──\n正在生成');
  });

  it('回放的思考折叠成一行，实时的思考以“思考：”开头', () => {
    const replay = renderer();
    replay.r.render(
      ev('assistant.thought', { turnId: 'trn_1', messageId: 'm1', text: '想一想', replaces: [] }),
    );
    expect(replay.text()).toBe('（思考过程 3 字，已折叠）\n');
    const live = renderer();
    live.r.caughtUp();
    live.r.render(delta('想', 0, 'reasoning'));
    live.r.render(delta('好了', 1));
    expect(live.text()).toBe('思考：想\n好了');
  });

  it('被放弃的一段输出给出提示', () => {
    const { r, text } = renderer();
    r.caughtUp();
    r.render(delta('半句'));
    r.render(
      ev('assistant.stream_ended', { turnId: 'trn_1', streamId: 'stm_1', outcome: 'abandoned' }),
    );
    expect(text()).toBe('半句\n（以上输出已被模型放弃）\n');
  });

  it('工具调用：一行摘要，失败时带输出的开头', () => {
    const { r, text } = renderer();
    r.caughtUp();
    r.render(
      ev('tool.started', {
        turnId: 'trn_1',
        toolCallId: 'call_1',
        toolName: 'bash',
        display: { kind: 'shell', command: 'ls -la', summary: 'ls -la' },
      }),
    );
    r.render(
      ev('tool.finished', {
        turnId: 'trn_1',
        toolCallId: 'call_1',
        status: 'failed',
        output: { text: 'sandbox: write denied\nmore', truncated: false },
      }),
    );
    expect(text()).toBe('● bash ls -la\n  ⎿ bash 失败：sandbox: write denied more\n');
  });

  it('审批：卡片列出理由、权限与选项；另一端处理时显示处理者', () => {
    const { r, text } = renderer();
    r.caughtUp();
    r.render(ev('approval.requested', { approval }));
    r.render(
      ev('approval.resolved', {
        approvalId: APR,
        status: 'approved',
        resolution: {
          reason: 'user',
          optionId: 'allow',
          decidedBy: { clientKind: 'desktop', deviceId: 'dev-9', clientId: 'desk-1' },
        },
      }),
    );
    expect(text()).toBe(
      [
        '⚠ 需要审批：write /home/u/out/summary.md',
        '  理由：用户要求另存一份',
        '  申请权限：danger-full-access',
        '  选项：1) 允许一次  2) 拒绝',
        '✓ 已由 desktop/dev-9 处理：允许一次',
        '',
      ].join('\n'),
    );
  });

  it('子 agent（R4）：开始、完成各一行；它的审批标出来源，结束后说明', () => {
    const { r, text } = renderer();
    r.caughtUp();
    const child: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPZZ';
    const summary = {
      sessionId: child,
      parentToolCallId: 'call_spawn_1',
      title: 'Helper task',
      modelId: 'deepseek-chat',
      reasoningEffort: 'medium',
      status: 'running' as const,
      startedAt: '2026-10-13T00:00:00.000Z',
      pendingApprovals: [],
    };
    const childApproval = { ...approval, sessionId: child };
    r.render(ev('subagent.started', { subagent: summary }));
    r.render(
      ev('subagent.updated', { subagent: { ...summary, pendingApprovals: [childApproval] } }),
    );
    r.render(ev('subagent.updated', { subagent: { ...summary, title: 'Mock：核对' } }));
    r.render(
      ev('subagent.updated', {
        subagent: { ...summary, title: 'Mock：核对', status: 'completed' },
      }),
    );
    expect(text()).toBe(
      [
        '↳ 子 agent 启动：Helper task（deepseek-chat · medium）',
        '⚠ 需要审批（来自子 agent Helper task）：write /home/u/out/summary.md',
        '  理由：用户要求另存一份',
        '  申请权限：danger-full-access',
        '  选项：1) 允许一次  2) 拒绝',
        '（子 agent Mock：核对 的审批已结束）',
        '↳ 子 agent 完成：Mock：核对',
        '',
      ].join('\n'),
    );
  });

  it('审批：本终端处理的、以及非用户结束的', () => {
    const here = renderer({ decidedHere: true });
    here.r.caughtUp();
    here.r.render(ev('approval.requested', { approval }));
    here.r.render(
      ev('approval.resolved', {
        approvalId: APR,
        status: 'denied',
        resolution: {
          reason: 'user',
          optionId: 'reject',
          decidedBy: { clientKind: 'cli', deviceId: 'dev-1', clientId: 'cli-1' },
        },
      }),
    );
    expect(here.text()).toContain('✓ 本终端已处理：拒绝\n');
    const cancelled = renderer();
    cancelled.r.render(
      ev('approval.resolved', {
        approvalId: APR,
        status: 'cancelled',
        resolution: { reason: 'turn_cancelled' },
      }),
    );
    expect(cancelled.text()).toBe('审批已取消（回合已取消）\n');
  });

  it('本终端输入过的消息不重复显示；其他客户端的消息注明来源', () => {
    const { r, text } = renderer({ echoed: 'cli-msg-1' });
    r.caughtUp();
    r.render(ev('user.message', { ...userMessage('我打的'), clientMessageId: 'cli-msg-1' }));
    r.render(
      ev('user.message', {
        ...userMessage('桌面发的'),
        sentBy: { clientKind: 'desktop', deviceId: 'dev-9', clientId: 'desk-1' },
      }),
    );
    expect(text()).toBe('\n› 桌面发的（来自 desktop/dev-9）\n');
  });

  it('引擎错误给出下一步建议', () => {
    const { r, text } = renderer();
    r.render(
      ev('engine.error', {
        category: 'missing_credentials',
        message: 'no api key',
        fatal: false,
      }),
    );
    expect(text()).toContain('引擎错误（缺少凭据）：no api key\n下一步：');
    expect(text()).toContain('wevir provider add');
  });

  it('英文：标签、审批与复数', () => {
    setLocale('en');
    const { r, text } = renderer();
    r.render(ev('engine.error', { category: 'provider', message: '401', fatal: false }));
    r.render(ev('approval.requested', { approval }));
    r.render(
      ev('assistant.thought', { turnId: 'trn_1', messageId: 't1', text: 'x', replaces: [] }),
    );
    r.render(ev('turn.finished', { turnId: 'trn_1', outcome: 'cancelled', durationMs: 65_000 }));
    expect(text()).toBe(
      [
        'Engine error (provider error): 401',
        'Next: Run wevir provider test to check the address, model and key',
        '⚠ Approval needed: write /home/u/out/summary.md',
        '  Reason: 用户要求另存一份',
        '  Requested permissions: danger-full-access',
        '  Options: 1) Allow once  2) Reject',
        '(reasoning, 1 character, collapsed)',
        '── Turn cancelled · 1 min 5 s ──',
        '',
      ].join('\n'),
    );
  });
});

function userMessage(text: string): WevirEventPayload<'user.message'> {
  return {
    turnId: 'trn_1',
    content: [{ type: 'text', text }],
    sentBy: { clientKind: 'cli', deviceId: 'dev-1', clientId: 'cli-1' },
  };
}
