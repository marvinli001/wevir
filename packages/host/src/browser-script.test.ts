// browser_run 的沙箱（browser-script.ts）：QuickJS 里跑脚本，浏览器调用交给宿主；拿不到 Node、文件与网络；总时限、取消、
// 调用上限与死循环都会停下。

import { describe, expect, it } from 'vitest';
import { runBrowserScript, ScriptCallError, type ScriptHost } from './browser-script.js';

function recorder(answer: (name: string, input: Record<string, unknown>) => unknown = () => 'ok') {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const host: ScriptHost = {
    call: async (name, input) => {
      calls.push({ name, input });
      return answer(name, input);
    },
  };
  return { calls, host };
}

const base = { timeoutMs: 5_000, maxCalls: 50, signal: new AbortController().signal };

describe('browser_run 的沙箱', () => {
  it('按顺序调用宿主，返回值、console 与按位置或对象给的参数', async () => {
    const { calls, host } = recorder((name) =>
      name === 'browser_query'
        ? { count: 1, elements: [{ ref: '@e7', text: 'Next' }] }
        : `did ${name}`,
    );
    const run = await runBrowserScript({
      ...base,
      host,
      browserId: 'tab_1',
      source: `const found = await tab.query('a.next');
console.log('found', found.count, found.elements[0]);
await tab.click(found.elements[0].ref);
await tab.fill('@e3', 'Ada');
await tab.type('hello');
await tab.type('@e4', 'there');
await tab.keypress('Enter');
await tab.scroll(400);
await tab.wait({ selector: '#done' });
const other = browser.tab('tab_2');
await other.snapshot({ changes: true });
return { clicked: found.elements[0].ref, n: 2 };`,
    });
    expect(run.status).toBe('ok');
    expect(run.value).toBe('{"clicked":"@e7","n":2}');
    expect(run.logs).toEqual(['found 1 {"ref":"@e7","text":"Next"}']);
    expect(calls).toEqual([
      { name: 'browser_query', input: { selector: 'a.next', browserId: 'tab_1' } },
      { name: 'browser_click', input: { ref: '@e7', browserId: 'tab_1' } },
      { name: 'browser_fill', input: { ref: '@e3', value: 'Ada', browserId: 'tab_1' } },
      { name: 'browser_type', input: { text: 'hello', browserId: 'tab_1' } },
      { name: 'browser_type', input: { ref: '@e4', text: 'there', browserId: 'tab_1' } },
      { name: 'browser_keypress', input: { key: 'Enter', browserId: 'tab_1' } },
      { name: 'browser_scroll', input: { deltaY: 400, browserId: 'tab_1' } },
      { name: 'browser_wait', input: { selector: '#done', browserId: 'tab_1' } },
      { name: 'browser_snapshot', input: { changes: true, browserId: 'tab_2' } },
    ]);
    expect(run.calls).toBe(9);
  });

  it('对象形式的参数不能换掉绑定的标签页；evaluate 收函数的源码', async () => {
    const { calls, host } = recorder();
    const run = await runBrowserScript({
      ...base,
      host,
      browserId: 'tab_1',
      source: `await tab.click({ ref: '@e1', browserId: 'someone-else' });
await tab.evaluate(() => document.title);`,
    });
    expect(run.status).toBe('ok');
    expect(calls[0]?.input).toEqual({ ref: '@e1', browserId: 'tab_1' });
    expect(calls[1]?.input.function).toMatch(/document\.title/);
  });

  it('沙箱里没有 Node、文件、网络与模块加载', async () => {
    const { host } = recorder();
    const run = await runBrowserScript({
      ...base,
      host,
      source: `return [typeof require, typeof process, typeof fetch, typeof XMLHttpRequest, typeof WebSocket,
        typeof std, typeof os, typeof setTimeout, typeof __wevir_call, typeof __wevir_log];`,
    });
    expect(run.status).toBe('ok');
    expect(JSON.parse(run.value ?? '[]')).toEqual(Array(10).fill('undefined'));
    const dynamicImport = await runBrowserScript({
      ...base,
      host,
      source: `return await import('node:fs');`,
    });
    expect(dynamicImport.status).toBe('error');
  });

  it('浏览器调用失败时抛带 code 的 BrowserError，能接住；接不住时报出错误码', async () => {
    const { host } = recorder((name) => {
      if (name === 'browser_click')
        throw new ScriptCallError('browser_stale_ref', 'Ref @e3 is stale.');
      return 'ok';
    });
    const caught = await runBrowserScript({
      ...base,
      host,
      browserId: 't',
      source: `try { await tab.click('@e3'); } catch (error) { return [error.name, error.code, error.message]; }`,
    });
    expect(JSON.parse(caught.value ?? '[]')).toEqual([
      'BrowserError',
      'browser_stale_ref',
      'Ref @e3 is stale.',
    ]);
    const thrown = await runBrowserScript({
      ...base,
      host,
      browserId: 't',
      source: `console.log('before');\nawait tab.click('@e3');\nconsole.log('after');`,
    });
    expect(thrown).toMatchObject({
      status: 'error',
      errorCode: 'browser_stale_ref',
      error: 'Ref @e3 is stale.',
      logs: ['before'],
    });
  });

  it('语法错误与普通异常带行号', async () => {
    const { host } = recorder();
    const syntax = await runBrowserScript({ ...base, host, source: 'const = 1;' });
    expect(syntax.status).toBe('error');
    expect(syntax.error).toMatch(/does not compile: SyntaxError/);
    const thrown = await runBrowserScript({
      ...base,
      host,
      source: `const a = 1;\nconst b = 2;\nnull.x;`,
    });
    expect(thrown.status).toBe('error');
    expect(thrown.error).toMatch(/TypeError.*\(line 3\)/);
  });

  it('死循环按总时限停下', async () => {
    const { host } = recorder();
    const started = Date.now();
    const run = await runBrowserScript({
      ...base,
      timeoutMs: 300,
      host,
      source: 'while (true) {}',
    });
    expect(run.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('等着宿主时超时或被取消就停下，宿主调用收到中止', async () => {
    let aborted = false;
    const host: ScriptHost = {
      call: (_name, _input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          });
        }),
    };
    const timedOut = await runBrowserScript({
      ...base,
      timeoutMs: 200,
      host,
      browserId: 't',
      source: 'await tab.snapshot();',
    });
    expect(timedOut.status).toBe('timeout');
    expect(aborted).toBe(true);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await runBrowserScript({
      ...base,
      signal: controller.signal,
      host,
      browserId: 't',
      source: 'await tab.snapshot();',
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('调用次数到上限就停下', async () => {
    const { calls, host } = recorder();
    const run = await runBrowserScript({
      ...base,
      maxCalls: 3,
      host,
      browserId: 't',
      source: 'for (let i = 0; i < 10; i += 1) await tab.hover("@e1");',
    });
    expect(run.status).toBe('limit');
    expect(calls).toHaveLength(3);
  });

  it('内存用光时报错而不是拖垮 Host；输出截短', async () => {
    const { host } = recorder();
    const memory = await runBrowserScript({
      ...base,
      host,
      source: 'const a = []; while (true) a.push("x".repeat(1e6));',
    });
    expect(memory.status).toBe('error');
    const noisy = await runBrowserScript({
      ...base,
      host,
      source: 'for (let i = 0; i < 1000; i += 1) console.log("line", i);',
    });
    expect(noisy.status).toBe('ok');
    expect(noisy.logs.length).toBeLessThanOrEqual(300);
    expect(noisy.logsDropped).toBeGreaterThan(0);
    // 把 64 MB 填满要几秒（机器忙时更久）。
  }, 30_000);
});
