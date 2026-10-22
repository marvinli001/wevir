// 开发服务器预览的应用级工具（preview-tools.ts）：假的预览服务与浏览器。已在跑的配置再启动时切到这个会话里开着它的标签页，不再开一个；
// 没有开着的标签页时照常打开地址。

import type { BrowserCommand, SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { BrowserBroker } from './browser-broker.js';
import type { PreviewService } from './preview/service.js';
import { previewTools } from './preview-tools.js';
import type { ProcessInfo, ProcessManager } from './processes.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQA' as SessionId;

const running: ProcessInfo = {
  id: 'p5',
  sessionId: SESSION,
  name: 'web',
  command: 'python3 -m http.server 8765',
  cwd: '/project',
  pid: 1,
  startedAt: 0,
  status: 'running',
  exitCode: null,
  signal: null,
  endedAt: undefined,
  logPath: '/logs/p5.log',
  bytes: 0,
  killed: false,
  preview: {
    name: 'web',
    root: '/project',
    port: 8765,
    url: 'http://localhost:8765',
    ready: true,
    startedBy: 'agent',
  },
};

function setup(tabs: Array<{ browserId: string; url: string; isActive: boolean }>) {
  const previews = {
    list: async () => ({
      root: '/project',
      configs: [
        {
          name: 'web',
          command: running.command,
          cwd: '',
          port: 8765,
          addedBy: 'agent',
          createdAt: '',
          updatedAt: '',
        },
      ],
      candidates: [],
    }),
    start: async () => ({ status: 'reused', process: running }),
    waitReady: async () => running,
  } as unknown as PreviewService;
  const commands: BrowserCommand[] = [];
  const browser = {
    execute: async ({ command }: { command: BrowserCommand }) => {
      commands.push(command);
      if (command.command === 'list_tabs') {
        return {
          ok: true,
          result: {
            command: 'list_tabs',
            tabs: tabs.map((tab) => ({
              ...tab,
              title: '',
              isLoading: false,
              controller: 'agent',
            })),
          },
        };
      }
      return {
        ok: true,
        result: { command: 'show', browserId: 'tab_new', url: '', shown: true },
      };
    },
  } as unknown as BrowserBroker;
  const tool = previewTools({
    previews,
    processes: {} as ProcessManager,
    browser,
  }).find((candidate) => candidate.name === 'wevir_preview_start');
  const call = async () => {
    const result = await tool?.call(
      { name: 'web' },
      { sessionId: SESSION, signal: new AbortController().signal },
    );
    const first = result?.content[0];
    return first?.type === 'text' ? first.text : '';
  };
  return { call, commands };
}

describe('wevir_preview_start', () => {
  it('shows the tab already open on a running preview instead of opening another', async () => {
    const { call, commands } = setup([
      { browserId: 'tab_other', url: 'http://localhost:3000/', isActive: false },
      { browserId: 'tab_preview', url: 'http://localhost:8765/docs', isActive: false },
    ]);
    const text = await call();
    expect(text).toContain('Already running "web": ready at http://localhost:8765; process p5.');
    expect(text).toContain('Showed its open tab tab_preview in the browser pane.');
    expect(commands.at(-1)).toEqual({ command: 'show', args: { browserId: 'tab_preview' } });
  });

  it('opens the address when no tab of this session shows it', async () => {
    const { call, commands } = setup([
      { browserId: 'tab_other', url: 'http://localhost:3000/', isActive: true },
    ]);
    expect(await call()).toContain('Opened it in the browser pane.');
    expect(commands.at(-1)).toEqual({
      command: 'show',
      args: { url: 'http://localhost:8765' },
    });
  });
});
