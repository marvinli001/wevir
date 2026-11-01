import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolDetails } from './tool-details';
import type { ToolPart } from './tool-model';

function command(extra: Partial<ToolPart> = {}): ToolPart {
  return {
    type: 'tool',
    key: 't:exec-1',
    toolCallId: 'exec-1',
    toolName: 'commandExecution',
    display: { kind: 'shell', command: 'rg match present missing' },
    status: 'failed',
    input: {
      type: 'commandExecution',
      command: 'rg match present missing',
      cwd: '/tmp',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
      processId: '123',
    },
    startedAt: '2026-11-01T10:00:00.000Z',
    ...extra,
  };
}

describe('ToolDetails', () => {
  it('部分输出后失败：展示最终退出码、匹配内容与错误，参数中不展示启动状态', () => {
    const html = renderToStaticMarkup(
      createElement(ToolDetails, {
        part: command({
          exitCode: 2,
          output: {
            text: 'present:1:match\nrg: missing: No such file or directory (os error 2)',
            truncated: false,
          },
        }),
      }),
    );
    expect(html).toContain('退出码 2');
    expect(html).toContain('present:1:match');
    expect(html).toContain('No such file or directory');
    expect(html).toContain('/tmp');
    for (const field of ['inProgress', 'aggregatedOutput', 'exitCode', 'processId']) {
      expect(html).not.toContain(field);
    }
  });

  it('无输出的成功命令仍展示退出码 0；旧记录不推测最终退出码', () => {
    const success = renderToStaticMarkup(
      createElement(ToolDetails, { part: command({ status: 'completed', exitCode: 0 }) }),
    );
    expect(success).toContain('退出码 0');
    expect(success).toContain('无输出');
    const historical = renderToStaticMarkup(createElement(ToolDetails, { part: command() }));
    expect(historical).not.toContain('退出码');
    expect(historical).not.toContain('inProgress');
  });
});
