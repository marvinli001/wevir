// 电脑操作（0.112.0）：ComputerBroker 选提供方、超时、断开与取消；computer_* 工具的参数校验、设置开关与第一次批准后的使用规则。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerRequest, ComputerResponse, SessionId } from '@wevir/protocol';
import { COMPUTER_COMMANDS } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppTool } from './app-mcp.js';
import { ComputerBroker } from './computer-broker.js';
import { COMPUTER_TOOLS, computerTools, loadComputerGuide } from './computer-tools.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

function provider(
  id: string,
  answer?: (request: ComputerRequest) => ComputerResponse | undefined,
  commands: readonly string[] = COMPUTER_COMMANDS,
) {
  const requests: ComputerRequest[] = [];
  let broker: ComputerBroker | undefined;
  return {
    id,
    commands,
    requests,
    attach(target: ComputerBroker) {
      broker = target;
      return target.register(this);
    },
    send(request: ComputerRequest) {
      requests.push(request);
      const response = answer?.(request);
      if (response) queueMicrotask(() => broker?.respond(id, response));
      return true;
    },
  };
}

const text = (requestId: ComputerRequest['requestId'], value: string): ComputerResponse => ({
  requestId,
  ok: true,
  result: { content: [{ type: 'text', text: value }] },
});

const listApps = { sessionId: SESSION, command: { command: 'list_apps' as const, args: {} } };

describe('ComputerBroker', () => {
  it('没有提供方时回 computer_no_host；交给最近登记的提供方', async () => {
    const broker = new ComputerBroker();
    expect(await broker.execute(listApps)).toMatchObject({
      ok: false,
      error: { code: 'computer_no_host' },
    });
    const first = provider('a', (request) => text(request.requestId, 'from a'));
    const second = provider('b', (request) => text(request.requestId, 'from b'));
    first.attach(broker);
    second.attach(broker);
    expect(await broker.execute(listApps)).toEqual({
      ok: true,
      result: { content: [{ type: 'text', text: 'from b' }] },
    });
    expect(second.requests[0]).toMatchObject({ sessionId: SESSION, command: listApps.command });
    expect(first.requests).toHaveLength(0);
  });

  it('提供方不会的命令回 computer_unsupported', async () => {
    const broker = new ComputerBroker();
    provider('a', undefined, ['list_apps']).attach(broker);
    expect(
      await broker.execute({
        sessionId: SESSION,
        command: { command: 'clipboard_read', args: {} },
      }),
    ).toMatchObject({ ok: false, error: { code: 'computer_unsupported' } });
  });

  it('超时、断开与取消都以失败结束，迟到的回答不收', async () => {
    const broker = new ComputerBroker({ defaultTimeoutMs: 20 });
    const silent = provider('a');
    silent.attach(broker);
    expect(await broker.execute(listApps)).toMatchObject({
      ok: false,
      error: { code: 'computer_timeout' },
    });
    const late = silent.requests[0];
    expect(late && broker.respond('a', text(late.requestId, 'late'))).toBe(false);

    const pending = broker.execute({ ...listApps, timeoutMs: 5_000 });
    await Promise.resolve();
    broker.unregister('a');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'computer_no_host' } });

    provider('b').attach(broker);
    const controller = new AbortController();
    const cancelled = broker.execute({ ...listApps, timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { message: 'cancelled' } });
    expect(broker.pendingCount).toBe(0);
  });

  it('别的连接回答不算；失败的回答带上已经做完的步骤', async () => {
    const broker = new ComputerBroker();
    const own = provider('a');
    own.attach(broker);
    const pending = broker.execute(listApps);
    await Promise.resolve();
    const request = own.requests[0];
    if (request === undefined) throw new Error('no request');
    expect(broker.respond('b', text(request.requestId, 'x'))).toBe(false);
    expect(
      broker.respond('a', {
        requestId: request.requestId,
        ok: false,
        error: { code: 'computer_stopped', message: 'Esc' },
        content: [{ type: 'text', text: '1. click: done' }],
      }),
    ).toBe(true);
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'computer_stopped', message: 'Esc' },
      content: [{ type: 'text', text: '1. click: done' }],
    });
  });
});

function tool(tools: AppTool[], name: string): AppTool {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const call = { sessionId: SESSION, signal: new AbortController().signal };

describe('computer_* 工具', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(enabled = true, guide?: string) {
    const broker = new ComputerBroker();
    const seen = provider('a', (request) => {
      if (request.command.command === 'request_access') {
        return text(request.requestId, 'Approved: Notes (com.apple.Notes, full).');
      }
      return text(request.requestId, `did ${request.command.command}`);
    });
    seen.attach(broker);
    const tools = computerTools({
      broker,
      enabled: () => enabled,
      ...(guide !== undefined && { guide }),
    });
    return { tools, requests: seen.requests };
  }

  it('名单与工具一一对应；只读的标 readOnlyHint，动作不走引擎审批', () => {
    const { tools } = setup();
    expect(tools.map((entry) => entry.name).sort()).toEqual([...COMPUTER_TOOLS].sort());
    expect(tool(tools, 'computer_screenshot').annotations.readOnlyHint).toBe(true);
    const click = tool(tools, 'computer_click').annotations;
    expect(click).toMatchObject({ destructiveHint: false, openWorldHint: false });
    expect(click.readOnlyHint).toBe(false);
  });

  it('设置关着时回 computer_disabled，不发请求', async () => {
    const { tools, requests } = setup(false);
    const result = await tool(tools, 'computer_list_apps').call({}, call);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('computer_disabled') });
    expect(requests).toHaveLength(0);
  });

  it('参数组合不对时不发请求：点击坐标与元素恰好一种，滚动要有方向，找元素要有条件', async () => {
    const { tools, requests } = setup();
    for (const [name, args] of [
      ['computer_click', {}],
      ['computer_click', { x: 1, y: 2, ref: '@a1' }],
      ['computer_click', { x: 1 }],
      ['computer_click', { ref: '@e1' }],
      ['computer_scroll', { x: 1, y: 2 }],
      ['computer_ax_find', { app: 'Notes' }],
      ['computer_key', { keys: 'cmd+s', repeat: 500 }],
      ['computer_batch', { actions: [{ action: 'list_apps' }] }],
      ['computer_batch', { actions: [{ action: 'click' }] }],
    ] as const) {
      const result = await tool(tools, name).call(args as Record<string, unknown>, call);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('computer_invalid_argument'),
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('batch 的每一步换成命令；多余的参数去掉', async () => {
    const { tools, requests } = setup();
    const result = await tool(tools, 'computer_batch').call(
      {
        actions: [
          { action: 'click', ref: '@a3', text: 'ignored' },
          { action: 'type', text: 'Hello' },
          { action: 'wait', seconds: 0.5 },
          { action: 'key', keys: 'cmd+s' },
        ],
      },
      call,
    );
    expect(result.isError).toBeUndefined();
    expect(requests[0]?.command).toEqual({
      command: 'batch',
      args: {
        actions: [
          { command: 'click', args: { ref: '@a3' } },
          { command: 'type', args: { text: 'Hello' } },
          { command: 'wait', args: { seconds: 0.5 } },
          { command: 'key', args: { keys: 'cmd+s' } },
        ],
      },
    });
  });

  it('第一次批准后结果接上使用规则，同一个会话只给一次', async () => {
    const { tools } = setup(true, '# 电脑操作\n规则');
    const access = tool(tools, 'computer_request_access');
    const first = await access.call({ apps: ['Notes'], reason: 'notes' }, call);
    expect(first.content.map((part) => (part.type === 'text' ? part.text : ''))).toEqual([
      'Approved: Notes (com.apple.Notes, full).',
      '# 电脑操作\n规则',
    ]);
    const again = await access.call({ apps: ['Notes'], reason: 'notes' }, call);
    expect(again.content).toHaveLength(1);
  });

  it('使用规则：删注释、展开引入、去掉 YAML 头', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-computer-guide-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'plugins', 'computer-use'), { recursive: true });
    mkdirSync(join(dir, 'plugins', 'shared'), { recursive: true });
    writeFileSync(
      join(dir, 'plugins', 'computer-use', 'SKILL.md'),
      '---\nname: computer-use\ndescription: x\n---\n<!-- note -->\n# 电脑操作\n\n{{> plugins/shared/rules.md }}\n',
    );
    writeFileSync(join(dir, 'plugins', 'shared', 'rules.md'), '<!-- c -->\n## 确认\n');
    expect(loadComputerGuide(dir)).toBe('# 电脑操作\n\n\n## 确认');
  });

  it('仓库里的 SKILL.md 渲染得出来', () => {
    const guide = loadComputerGuide(join(import.meta.dirname, '..', '..', '..', 'prompts'));
    expect(guide).toContain('computer_request_access');
    expect(guide).toContain('## 界面操作的确认规则');
    expect(guide).not.toContain('<!--');
  });
});
