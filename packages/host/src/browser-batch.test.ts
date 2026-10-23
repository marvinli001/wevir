// browser_batch 与 browser_run（browser-batch.ts）：每一步经 BrowserBroker 交给桌面端（这里是假的提供方），批量按顺序、遇错即停，
// 脚本的调用逐个转成同名工具；会话用不了的工具在两者里都用不了；全是只读步骤的批量由 Host 替用户答应审批；审批卡片列出
// 每一步、写出脚本全文。

import type { BrowserRequest, BrowserResponse, BrowserResult, SessionId } from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import type { AppTool, AppToolResult } from './app-mcp.js';
import {
  appToolArgs,
  batchActions,
  browserBatchAutoAllowed,
  browserComposeDisplay,
  browserComposeTools,
} from './browser-batch.js';
import { BrowserBroker } from './browser-broker.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

/** callerCwd 只读会话与工作区。 */
const storage = {
  sessions: { get: () => ({ cwd: '/work', workspaceId: 'ws_1' }) },
  workspaces: { get: () => ({ id: 'ws_1' }) },
} as unknown as Storage;

function harness(
  answer: (request: BrowserRequest) => Omit<BrowserResponse, 'requestId'> | undefined,
  allowed?: string[],
) {
  const broker = new BrowserBroker();
  const requests: BrowserRequest[] = [];
  broker.register({
    id: 'desktop',
    commands: [...BROWSER_COMMANDS],
    send(request) {
      requests.push(request);
      const response = answer(request);
      if (response) {
        queueMicrotask(() =>
          broker.respond('desktop', {
            requestId: request.requestId,
            ...response,
          } as BrowserResponse),
        );
      }
      return true;
    },
  });
  const tools = browserComposeTools({
    storage,
    broker,
    ...(allowed !== undefined && { allowedTools: async () => new Set(allowed) }),
  });
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    (tools.find((tool) => tool.name === name) as AppTool).call(args, {
      sessionId: SESSION,
      signal: signal ?? new AbortController().signal,
    });
  return { call, requests, tools };
}

const ok = (result: BrowserResult) => ({ ok: true as const, result });

/** 一个会回答常见命令的桌面端。 */
type Answer = BrowserResponse extends infer R
  ? R extends unknown
    ? Omit<R, 'requestId'>
    : never
  : never;

function desktop(request: BrowserRequest): Answer | undefined {
  const { command } = request;
  switch (command.command) {
    case 'new_tab':
      return ok({ command: 'new_tab', browserId: 'tab_new', url: command.args.url ?? '' });
    case 'list_tabs':
      return ok({
        command: 'list_tabs',
        tabs: [
          {
            browserId: 'tab_1',
            url: 'https://example.com/done',
            title: 'Done',
            isActive: true,
            isLoading: false,
            controller: 'agent',
          },
        ],
      });
    case 'fill':
      return ok({ command: 'fill', browserId: command.args.browserId, ref: command.args.ref });
    case 'click':
      if (command.args.ref === '@e9') {
        return { ok: false, error: { code: 'browser_stale_ref', message: 'Ref @e9 is stale.' } };
      }
      return {
        ...ok({ command: 'click', browserId: command.args.browserId, ref: command.args.ref }),
        effects: { navigation: { url: 'https://example.com/next', status: 200 } },
      };
    case 'screenshot':
      return ok({
        command: 'screenshot',
        browserId: command.args.browserId,
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
        width: 10,
        height: 10,
      });
    case 'query':
      return ok({
        command: 'query',
        browserId: command.args.browserId,
        selector: command.args.selector,
        count: 2,
        elements: [
          { ref: '@e5', tag: 'a', text: 'One', visible: true },
          { ref: '@e6', tag: 'a', text: 'Two', visible: true },
        ],
      } as BrowserResult);
    case 'snapshot':
      return ok({
        command: 'snapshot',
        browserId: command.args.browserId,
        url: 'https://example.com/',
        title: 'Example',
        format: 'aria-yaml',
        ...(command.args.changes === true
          ? {
              snapshot: '# in: form "Login"\n+    - text: "Saved"',
              truncated: false,
              stats: {
                nodeCount: 3,
                refCount: 1,
                textLength: 40,
                totalLines: 3,
                startLine: 0,
                shownLines: 1,
                changes: { added: 1, removed: 0, unchanged: 2 },
              },
            }
          : {
              snapshot: '- button "Go" [ref=@e1]',
              truncated: false,
              stats: { nodeCount: 2, refCount: 1, textLength: 20 },
            }),
      });
    default:
      return undefined;
  }
}

function texts(result: AppToolResult): string {
  return result.content
    .flatMap((item) => (item.type === 'text' ? [item.text] : ['<image>']))
    .join('\n');
}

describe('browser_batch', () => {
  it('按顺序执行，默认标签页与新开的标签页，逐步结果与截图', async () => {
    const h = harness(desktop);
    const result = await h.call('browser_batch', {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_fill', input: { ref: '@e3', value: 'Ada' } },
        { name: 'click', input: { ref: '@e4' } },
        { name: 'browser_new_tab', input: { url: 'https://example.com/' } },
        { name: 'mcp__wevir__browser_screenshot' },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(h.requests.map((request) => request.command)).toEqual([
      { command: 'fill', args: { browserId: 'tab_1', ref: '@e3', value: 'Ada' } },
      { command: 'click', args: { browserId: 'tab_1', ref: '@e4' } },
      { command: 'new_tab', args: { url: 'https://example.com/' } },
      { command: 'screenshot', args: { browserId: 'tab_new' } },
    ]);
    const text = texts(result);
    expect(text).toMatch(/^Ran all 4 actions\./);
    expect(text).toContain('[1] browser_fill:\nFilled @e3.');
    expect(text).toContain(
      '[2] browser_click:\nClicked @e4.\nThe page navigated to https://example.com/next',
    );
    expect(result.content.at(-1)).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
  });

  it('遇到第一个错误就停，说明哪些没执行；参数错误的步骤不发出', async () => {
    const h = harness(desktop);
    const result = await h.call('browser_batch', {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_fill', input: { ref: '@e3', value: 'Ada' } },
        { name: 'browser_click', input: { ref: '@e9' } },
        { name: 'browser_click', input: { ref: '@e4' } },
        { name: 'browser_snapshot' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(h.requests).toHaveLength(2);
    const text = texts(result);
    expect(text).toMatch(
      /^Action 2 of 4 \(browser_click\) failed; the batch stopped there\. Actions 3–4 did not run\./,
    );
    expect(text).toContain('[2] browser_click failed:\n[browser_stale_ref] Ref @e9 is stale.');

    const bad = harness(desktop);
    const invalid = await bad.call('browser_batch', {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_click', input: { ref: 'not-a-ref' } },
        { name: 'browser_snapshot' },
      ],
    });
    expect(invalid.isError).toBe(true);
    expect(bad.requests).toHaveLength(0);
  });

  it('认不出的工具、套批量、空的步骤：一步都不执行', async () => {
    const h = harness(desktop);
    for (const actions of [
      [{ name: 'browser_teleport' }],
      [{ name: 'browser_batch', input: { actions: [] } }],
      [{ name: 'browser_run', input: { script: '1' } }],
      [],
      [{ input: {} }],
    ]) {
      const result = await h.call('browser_batch', { browserId: 'tab_1', actions });
      expect(result.isError, JSON.stringify(actions)).toBe(true);
      expect(texts(result)).toMatch(/^\[browser_invalid_argument\]/);
    }
    expect(h.requests).toHaveLength(0);
  });

  it('会话用不了的工具：整个批量不执行', async () => {
    const h = harness(desktop, ['browser_snapshot', 'browser_screenshot']);
    const result = await h.call('browser_batch', {
      browserId: 'tab_1',
      actions: [{ name: 'browser_snapshot' }, { name: 'browser_click', input: { ref: '@e1' } }],
    });
    expect(result.isError).toBe(true);
    expect(texts(result)).toMatch(/^\[browser_denied\] browser_click is not available/);
    expect(h.requests).toHaveLength(0);
  });

  it('取消时停下，之后的步骤不发出', async () => {
    const controller = new AbortController();
    const h = harness((request) => {
      if (request.command.command === 'click') {
        controller.abort();
        return undefined;
      }
      return desktop(request);
    });
    const result = await h.call(
      'browser_batch',
      {
        browserId: 'tab_1',
        actions: [{ name: 'browser_click', input: { ref: '@e1' } }, { name: 'browser_snapshot' }],
      },
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it('只读步骤的批量替用户答应；有要批准的步骤或参数不对时不替', () => {
    const readOnly = {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_snapshot' },
        { name: 'browser_screenshot' },
        { name: 'wait', input: { text: 'Done' } },
        { name: 'browser_query', input: { selector: 'a' } },
        { name: 'browser_close_tab' },
      ],
    };
    expect(browserBatchAutoAllowed(readOnly)).toBe(true);
    expect(browserBatchAutoAllowed(appToolArgs({ arguments: readOnly }))).toBe(true);
    expect(
      browserBatchAutoAllowed(
        appToolArgs({ providerIdentifier: 'wevir', toolName: 'browser_batch', args: readOnly }),
      ),
    ).toBe(true);
    expect(
      browserBatchAutoAllowed({
        actions: [...readOnly.actions, { name: 'browser_click', input: { ref: '@e1' } }],
      }),
    ).toBe(false);
    expect(browserBatchAutoAllowed({ actions: [{ name: 'browser_evaluate' }] })).toBe(false);
    expect(browserBatchAutoAllowed({ actions: [{ name: 'browser_nope' }] })).toBe(false);
    expect(browserBatchAutoAllowed({ actions: [] })).toBe(false);
    expect(browserBatchAutoAllowed('x')).toBe(false);
  });

  it('审批卡片：批量列出每一步，脚本写出全文', () => {
    const display = browserComposeDisplay('mcp__wevir__browser_batch', {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_fill', input: { ref: '@e3', value: 'Ada' } },
        { name: 'click', input: { ref: '@e4' } },
      ],
    });
    expect(display).toBe(
      'browserId: tab_1\n1. browser_fill {"ref":"@e3","value":"Ada"}\n2. browser_click {"ref":"@e4"}',
    );
    const script = 'for (const r of rows) {\n  await tab.click(r);\n}';
    expect(browserComposeDisplay('browser_run', { script, browserId: 'tab_1' })).toBe(
      `tab = tab_1\n${script}`,
    );
    expect(browserComposeDisplay('browser_click', { ref: '@e1' })).toBeUndefined();
    expect(typeof batchActions({ actions: 'x' })).toBe('string');
  });
});

describe('browser_run', () => {
  it('脚本的调用转成同名工具，读数据的命令给数据；结果有输出、返回值与最后的标签页', async () => {
    const h = harness(desktop);
    const result = await h.call('browser_run', {
      browserId: 'tab_1',
      script: `const { count, elements } = await tab.query('a');
console.log('links', count);
for (const element of elements) console.log(await tab.click(element.ref));
await tab.screenshot();
return elements.map((element) => element.text);`,
    });
    expect(result.isError).toBeUndefined();
    expect(h.requests.map((request) => request.command.command)).toEqual([
      'query',
      'click',
      'click',
      'screenshot',
      'list_tabs',
    ]);
    const text = texts(result);
    expect(text).toMatch(/^The script finished in [\d.]+ s with 4 browser calls\./);
    expect(text).toContain(
      'Console:\nlinks 2\nClicked @e5.\nThe page navigated to https://example.com/next',
    );
    expect(text).toContain('Returned: ["One","Two"]');
    expect(text).toContain(
      'Tabs now:\n- browserId=tab_1 controller=agent title="Done" url=https://example.com/done',
    );
    expect(result.content.at(-1)).toMatchObject({ type: 'image' });
  });

  it('浏览器错误抛给脚本、能接住；没接住时结果是错误并带错误码', async () => {
    const h = harness(desktop);
    const caught = await h.call('browser_run', {
      browserId: 'tab_1',
      script: `try { await tab.click('@e9'); } catch (error) { return error.code; }`,
    });
    expect(texts(caught)).toContain('Returned: "browser_stale_ref"');
    const failed = await h.call('browser_run', {
      browserId: 'tab_1',
      script: `await tab.click('@e9');`,
    });
    expect(failed.isError).toBe(true);
    expect(texts(failed)).toMatch(/failed after .*: \[browser_stale_ref\] Ref @e9 is stale\./);
  });

  it('没有标签页时说明怎样拿；browser.newTab 开的标签页能用；会话用不了的工具抛 browser_denied', async () => {
    const h = harness(desktop, ['browser_new_tab', 'browser_snapshot', 'browser_list_tabs']);
    const noTab = await h.call('browser_run', { script: 'await tab.snapshot();' });
    expect(noTab.isError).toBe(true);
    const opened = await h.call('browser_run', {
      script: `const t = await browser.newTab('https://example.com/');
const s = await t.snapshot();
let denied;
try { await t.click('@e1'); } catch (error) { denied = error.code; }
return { id: t.id, s: s.includes('button "Go"'), denied };`,
    });
    expect(texts(opened)).toContain(
      'Returned: {"id":"tab_new","s":true,"denied":"browser_denied"}',
    );
    expect(h.requests.map((request) => request.command.command)).not.toContain('click');
  });

  it('参数不对：空脚本、太长', async () => {
    const h = harness(desktop);
    expect((await h.call('browser_run', { script: '  ' })).isError).toBe(true);
    expect((await h.call('browser_run', { script: 'x'.repeat(20_001) })).isError).toBe(true);
    expect(h.requests).toHaveLength(0);
  });
});

describe('动作之后的增量快照（snapshot: true）', () => {
  it('批量里的一步带 snapshot 时接着取一次 changes 快照，接在这一步的结果后面', async () => {
    const h = harness(desktop);
    const result = await h.call('browser_batch', {
      browserId: 'tab_1',
      actions: [{ name: 'browser_fill', input: { ref: '@e2', value: 'a@b.c', snapshot: true } }],
    });
    expect(h.requests.map((request) => request.command)).toEqual([
      { command: 'fill', args: { browserId: 'tab_1', ref: '@e2', value: 'a@b.c' } },
      { command: 'snapshot', args: { browserId: 'tab_1', changes: true } },
    ]);
    const text = texts(result);
    expect(text).toContain('Page after it:');
    expect(text).toContain('Snapshot changes: 1 line added, 0 removed (3 lines now), 1 ref.');
    expect(text).toContain('+    - text: "Saved"');
  });

  it('失败的动作不再取快照；脚本里也能带 snapshot', async () => {
    const h = harness(desktop);
    const failed = await h.call('browser_batch', {
      browserId: 'tab_1',
      actions: [
        { name: 'browser_click', input: { ref: '@e9', snapshot: true } },
        { name: 'browser_click', input: { ref: '@e1' } },
      ],
    });
    expect(h.requests.map((request) => request.command.command)).toEqual(['click']);
    expect(texts(failed)).toMatch(/the batch stopped there\. Action 2 did not run\./);

    const run = await h.call('browser_run', {
      browserId: 'tab_1',
      script: 'return await tab.click("@e1", { snapshot: true });',
    });
    expect(h.requests.map((request) => request.command.command)).toEqual([
      'click',
      'click',
      'snapshot',
      'list_tabs',
    ]);
    expect(texts(run)).toContain('Snapshot changes: 1 line added');
  });
});
