import type { EngineNotice } from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EngineNoticeView } from './engine-notice-view';
import { type MessageActions, MessageActionsContext } from './message-actions';

vi.mock('./fold-state', () => ({
  useFold: (_key: string, initial: boolean) => [initial, () => {}],
}));

function render(detail: EngineNotice, actions: MessageActions = {}) {
  return renderToStaticMarkup(
    createElement(
      MessageActionsContext,
      { value: actions },
      createElement(EngineNoticeView, { detail }),
    ),
  );
}

describe('引擎通知', () => {
  it('保留警告、MCP 错误和暂缓输出的模型名，解除暂缓后清除状态', () => {
    expect(render({ kind: 'warning', message: '<warning>' })).toContain('&lt;warning&gt;');
    const failure = render({ kind: 'mcp_failed', server: 'fixture', message: 'timeout' });
    expect(failure).toContain('MCP 服务 fixture 启动失败');
    expect(failure).toContain('timeout');
    expect(render({ kind: 'output_buffering', model: 'model-a', active: true })).toContain(
      'model-a',
    );
    expect(render({ kind: 'output_buffering', model: 'model-a', active: false })).toBe('');
  });

  it('拒绝时直接显示原操作和理由，重试入口随会话权限和结果变化', () => {
    const denied = {
      kind: 'approval_review',
      reviewId: 'r1',
      status: 'denied',
      action: 'git status --short',
      rationale: 'Working copy unavailable',
      riskLevel: 'low',
    } as const;
    const html = render(denied);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('git status --short');
    expect(html).toContain('Working copy unavailable');
    expect(html).not.toContain('授权重试一次');
    const actions = { authorizeDenied: async () => {} };
    expect(render(denied, actions)).toContain('授权重试一次');
    for (const status of [
      'inProgress',
      'approved',
      'timedOut',
      'aborted',
      'userApproved',
    ] as const) {
      const finished = render({ ...denied, status }, actions);
      expect(finished).toContain(`data-approval-review="${status}"`);
      expect(finished).not.toContain('data-slot="button"');
    }
  });
});
