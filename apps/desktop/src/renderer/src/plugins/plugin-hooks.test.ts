import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginHooks } from './plugin-hooks';

describe('插件安装钩子清单', () => {
  it('逐条列出事件、matcher、完整命令和不支持的处理器，包含信任后果', () => {
    const html = renderToStaticMarkup(
      createElement(PluginHooks, {
        hooks: [
          {
            event: 'PreToolUse',
            matcher: 'Bash|Edit',
            handler: 'command',
            command: `node "\${PLUGIN_ROOT}/check.js"\nnode next.js`,
          },
          { event: 'Stop', handler: 'prompt' },
          { event: 'SessionStart', handler: 'command', command: '<img src=x onerror=alert(1)>' },
        ],
      }),
    );
    expect(html).toContain('PreToolUse');
    expect(html).toContain('Bash|Edit');
    expect(html).toContain(`\${PLUGIN_ROOT}/check.js`);
    expect(html).toContain('\nnode next.js');
    expect(html).toContain('prompt');
    expect(html).toContain('不支持');
    expect(html).toContain('安装后将信任以下钩子');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('没有钩子时不显示清单与警告', () => {
    expect(renderToStaticMarkup(createElement(PluginHooks, { hooks: [] }))).toBe('');
  });
});
