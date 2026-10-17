// 发给页面的脚本在 Node 的 vm 里跑一遍（没有 DOM，只看取值与序列化）：browser_evaluate 的包装、prompt 与 confirm 的替身。

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { promptShimDrainScript, promptShimInstallScript } from './dialog-handling.js';
import { buildEvaluateScript, syntaxError } from './service.js';

async function evaluate(source: string, maxChars = 6_000, globals: Record<string, unknown> = {}) {
  const context = createContext({ ...globals });
  return runInContext(buildEvaluateScript(source, undefined, maxChars), context) as Promise<
    Record<string, unknown>
  >;
}

describe('syntaxError', () => {
  it('accepts functions, async functions and expressions', () => {
    expect(syntaxError('() => document.title')).toBeUndefined();
    expect(syntaxError('async () => { await 1; return 2; }')).toBeUndefined();
    expect(syntaxError('document.title')).toBeUndefined();
    expect(syntaxError('await Promise.resolve(1)')).toBeUndefined();
  });

  it('reports what does not parse', () => {
    expect(syntaxError('() => {')).toMatch(/Unexpected|missing/);
    expect(syntaxError('return 1')).toBeDefined();
  });
});

describe('buildEvaluateScript', () => {
  it('calls a function and returns JSON with its type', async () => {
    await expect(evaluate('() => ({ a: 1, b: [true, null] })')).resolves.toEqual({
      ok: true,
      type: 'object',
      value: '{"a":1,"b":[true,null]}',
      length: 23,
    });
    await expect(evaluate('async () => [1, 2]')).resolves.toMatchObject({
      type: 'array',
      value: '[1,2]',
    });
    await expect(evaluate('6 * 7')).resolves.toMatchObject({ type: 'number', value: '42' });
    await expect(evaluate('() => undefined')).resolves.toMatchObject({
      type: 'undefined',
      value: 'undefined',
    });
  });

  it('writes values JSON cannot hold', async () => {
    const result = await evaluate(
      `() => {
        const circular = { name: 'loop' };
        circular.self = circular;
        return {
          map: new Map([['k', 1]]),
          set: new Set([2]),
          big: 10n,
          date: new Date(0),
          nan: NaN,
          fn: function named() {},
          circular,
        };
      }`,
    );
    expect(JSON.parse(String(result.value))).toEqual({
      map: { '[Map]': [['k', 1]] },
      set: { '[Set]': [2] },
      big: '10n',
      date: '1970-01-01T00:00:00.000Z',
      nan: 'NaN',
      fn: '[Function named]',
      circular: { name: 'loop', self: '[Circular]' },
    });
  });

  it('cuts the JSON to maxChars and reports the full length', async () => {
    await expect(evaluate('() => "x".repeat(50)', 10)).resolves.toEqual({
      ok: true,
      type: 'string',
      value: `"${'x'.repeat(9)}`,
      length: 52,
    });
  });

  it('returns what the function threw as name and message', async () => {
    await expect(evaluate('() => { throw new TypeError("bad input"); }')).resolves.toEqual({
      thrown: 'TypeError: bad input',
    });
    await expect(evaluate('() => { throw "plain"; }')).resolves.toEqual({
      thrown: 'Thrown: plain',
    });
  });

  it('passes the element of a ref as the first argument', async () => {
    const context = createContext({
      target: { nodeType: 1, tagName: 'BUTTON', id: 'go', textContent: ' Go ' },
    });
    const script = buildEvaluateScript('(element) => element', 'target', 100);
    await expect(runInContext(script, context)).resolves.toMatchObject({
      type: 'element',
      value: '"<button#go> Go"',
    });
    const missing = buildEvaluateScript('(element) => element', 'null', 100);
    await expect(runInContext(missing, context)).resolves.toEqual({ staleRef: true });
  });
});

describe('prompt and confirm shims', () => {
  function page() {
    const context = createContext({});
    runInContext('var window = globalThis;', context);
    return {
      run: (code: string) => runInContext(code, context),
    };
  }

  it('answer by the policy and record what they answered', () => {
    const tab = page();
    tab.run(promptShimInstallScript());
    expect(tab.run('window.confirm("Delete?")')).toBe(false);
    expect(tab.run('window.prompt("Name?", "x")')).toBeNull();
    tab.run(
      promptShimInstallScript({
        confirm: 'accept',
        prompt: 'accept',
        promptText: 'Alice',
        beforeunload: 'accept',
      }),
    );
    expect(tab.run('window.confirm("Again?")')).toBe(true);
    expect(tab.run('window.prompt("Name?", "x")')).toBe('Alice');
    const recorded = tab.run(promptShimDrainScript()) as Array<Record<string, unknown>>;
    expect(recorded.map(({ timestamp: _timestamp, ...entry }) => entry)).toEqual([
      { type: 'confirm', message: 'Delete?', action: 'dismissed' },
      { type: 'prompt', message: 'Name?', defaultValue: 'x', action: 'dismissed' },
      { type: 'confirm', message: 'Again?', action: 'accepted' },
      {
        type: 'prompt',
        message: 'Name?',
        defaultValue: 'x',
        action: 'accepted',
        response: 'Alice',
      },
    ]);
    expect(tab.run(promptShimDrainScript())).toEqual([]);
  });

  it('accepting a prompt without text answers its default value', () => {
    const tab = page();
    tab.run(
      promptShimInstallScript({ confirm: 'dismiss', prompt: 'accept', beforeunload: 'accept' }),
    );
    expect(tab.run('window.prompt("Name?", "Bob")')).toBe('Bob');
  });
});
