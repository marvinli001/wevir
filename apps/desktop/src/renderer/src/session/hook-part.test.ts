import type { ChatPartOf } from '@wevir/client-sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HookPart } from './hook-part';

const state = vi.hoisted(() => ({ open: false }));
vi.mock('./fold-state', () => ({ useFold: () => [state.open, () => {}] }));

function render(action: string, extra: Partial<ChatPartOf<'hook'>['outcome']> = {}) {
  return renderToStaticMarkup(
    createElement(HookPart, {
      part: {
        type: 'hook',
        key: 'hook:1',
        outcome: {
          event: 'PreToolUse',
          action,
          command: 'node check.js',
          reason: 'blocked <script>bad()</script>',
          ...extra,
        },
      },
    }),
  );
}

describe('钩子结果', () => {
  it('拦下、改判与上下文使用不同图标与状态色，默认折叠详情', () => {
    state.open = false;
    const blocked = render('blocked');
    const changed = render('continued');
    const context = render('context');
    expect(blocked).toContain('lucide-shield-ban');
    expect(blocked).toContain('text-destructive');
    expect(changed).toContain('lucide-replace');
    expect(changed).toContain('text-warning');
    expect(context).toContain('lucide-message-square-plus');
    expect(context).toContain('text-running');
    for (const html of [blocked, changed, context]) {
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('<pre');
    }
  });

  it('展开保留完整命令和多行理由，外部内容只作为文本', () => {
    state.open = true;
    const html = render('denied', { command: 'node check.js\nnode more.js' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('node check.js\nnode more.js');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('错误、上限与未来动作保留状态，无详情时不可展开', () => {
    state.open = false;
    expect(render('failed')).toContain('text-destructive');
    expect(render('limit')).toContain('text-warning');
    expect(render('future-action')).toContain('future-action');
    const html = render('allowed', { command: undefined, reason: undefined });
    expect(html).toContain('disabled');
    expect(html).not.toContain('aria-expanded');
  });
});
