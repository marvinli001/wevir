import { createHash } from 'node:crypto';
import type { GatewayPrivacySettings } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { GatewayPrivacyMasker } from './privacy.js';
import { restoreResponses, SecretRestorer } from './privacy-response.js';
import { sseEvent } from './sse.js';
import { parseEvents } from './test-fixtures/codex.js';
import type { ResponsesEvent } from './types.js';

const key = 'sk-fictional-key-for-privacy-tests-0123456789';
const request = (text: string) => ({ model: 'mock', input: text });
const masker = (known: string[] = [], settings: GatewayPrivacySettings = { enabled: true }) =>
  new GatewayPrivacyMasker({ settings: () => settings, secrets: () => known });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function* pieces(chunks: Array<string | Uint8Array>) {
  yield* chunks;
}

async function restored(
  events: ResponsesEvent[],
  values: ReadonlyMap<string, string>,
  bytes = false,
) {
  const data = events.map(sseEvent).join('');
  const chunks = bytes
    ? [...new TextEncoder().encode(data)].map((byte) => Uint8Array.of(byte))
    : [data];
  let out = '';
  for await (const piece of restoreResponses(pieces(chunks), values, 'text/event-stream'))
    out += piece;
  return parseEvents(out);
}

describe('GatewayPrivacyMasker', () => {
  it('已知值优先且长值先换，既有规则覆盖完整私钥与各种令牌', async () => {
    const known = ['short-secret', 'short-secret-and-longer'];
    const secrets = [
      key,
      `ghp_${'a'.repeat(30)}`,
      'AKIA0123456789ABCDEF',
      `Bearer ${'t'.repeat(30)}`,
      `AIza${'a'.repeat(35)}`,
      'xoxb-fictional-token-1234567890',
      '-----BEGIN PRIVATE KEY-----\nfictional material\n-----END PRIVATE KEY-----',
      ...known,
    ];
    const text = secrets.join('\n');
    const masked = await masker(known).prepare(request(text), []);
    expect(masked?.values.size).toBe(secrets.length);
    for (const secret of secrets) expect(masked?.body.input).not.toContain(secret);
    expect(masked?.body.input).not.toContain('fictional material');
    const restore = new SecretRestorer(masked?.values ?? new Map());
    expect(restore.push(masked?.body.input as string) + restore.end()).toBe(text);
  });

  it('同值在同一 Host 生命周期里占位符一致，还原表只包含本次请求的值', async () => {
    const privacy = masker();
    const first = await privacy.prepare(request(`${key} ${key}`), []);
    const second = await privacy.prepare(request(key), [key]);
    const token = [...(first?.values.keys() ?? [])][0] as string;
    expect(token).toMatch(/^\{\{SECRET_API_KEY_[a-f0-9]{20}\}\}$/);
    expect(first?.body.input).toBe(`${token} ${token}`);
    expect(second?.body.input).toBe(token);
    const other = await privacy.prepare(request(`ghp_${'b'.repeat(30)}`), []);
    expect(other?.values.has(token)).toBe(false);
    const restore = new SecretRestorer(other?.values ?? new Map());
    expect(restore.push(token) + restore.end()).toBe(token);
  });

  it('精确值摘要与正则豁免保持原值，不被后面的 Bearer 规则重新遮蔽', async () => {
    const privacy = masker([key], {
      enabled: true,
      excludedValueHashes: [digest(key)],
      excludedPatterns: ['^ghp_'],
    });
    const text = `Bearer ${key} ghp_${'a'.repeat(30)} xoxb-should-be-masked-123`;
    const masked = await privacy.prepare(request(text), []);
    expect(masked?.body.input).toContain(`Bearer ${key}`);
    expect(masked?.body.input).toContain(`ghp_${'a'.repeat(30)}`);
    expect(masked?.values.size).toBe(1);
  });

  it('工具结果中嵌套 JSON 的转义值同样被遮蔽，请求对象不被改写', async () => {
    const value = 'fictional-quote-"-newline-\n-secret';
    const text = JSON.stringify({ value });
    const body = request(text);
    const masked = await masker([value]).prepare(body, []);
    expect(body.input).toBe(text);
    expect(masked?.body.input).not.toContain('fictional-quote');
    const token = [...(masked?.values.keys() ?? [])][0];
    expect(JSON.parse(masked?.body.input as string)).toEqual({ value: token });
  });

  it('连接器认证头的裸凭据同样进入已知值匹配', async () => {
    const value = 'fictional-header-credential';
    const masked = await masker([`Bearer ${value}`]).prepare(request(value), []);
    expect(masked?.body.input).not.toContain(value);
    expect([...(masked?.values.values() ?? [])]).toEqual([value]);
  });

  it('关闭时不读值表，不复制或改写正文', async () => {
    const privacy = new GatewayPrivacyMasker({
      settings: () => ({ enabled: false }),
      secrets: () => {
        throw new Error('must not read');
      },
    });
    const body = request(key);
    expect(await privacy.prepare(body, [])).toBeUndefined();
    expect(body.input).toBe(key);
  });
});

describe('隐私流式还原', () => {
  it('非 SSE 的 JSON 字节流也即时输出，arguments 内的引号与换行保持有效', async () => {
    const value = 'fictional-quote-"-newline-\n-密钥';
    const masked = await masker([value]).prepare(request(value), []);
    const token = masked?.body.input as string;
    const source = JSON.stringify({
      text: 'x'.repeat(100_000),
      output: [{ type: 'function_call', arguments: JSON.stringify({ value: token }) }],
    });
    const at = source.indexOf(token) + 10;
    const stream = restoreResponses(
      pieces([source.slice(0, at), source.slice(at)]),
      masked?.values ?? new Map(),
      'application/json',
    );
    const first = await stream.next();
    expect((first.value as string).length).toBeGreaterThan(100_000);
    let result = first.value as string;
    for await (const piece of stream) result += piece;
    expect(JSON.parse(JSON.parse(result).output[0].arguments)).toEqual({ value });
  });
  it('占位符在每个位置切开都能恢复，普通长文本即时输出', async () => {
    const masked = await masker().prepare(request(key), []);
    const values = masked?.values ?? new Map();
    const token = masked?.body.input as string;
    for (let i = 1; i < token.length; i++) {
      const restore = new SecretRestorer(values);
      expect(restore.push(`before ${token.slice(0, i)}`)).toBe('before ');
      expect(restore.push(`${token.slice(i)} after`) + restore.end()).toBe(`${key} after`);
    }
    const restore = new SecretRestorer(values);
    expect(restore.push(`${'x'.repeat(100_000)}{{SE`)).toBe('x'.repeat(100_000));
    expect(restore.push('different') + restore.end()).toBe('{{SEdifferent');
  });

  it('逐字节的 UTF-8 SSE、交错文本流与参数流分别恢复，done 与 completed 同步恢复', async () => {
    const value = 'fictional-quote-"-newline-\n-密钥';
    const masked = await masker([value]).prepare(request(value), []);
    const token = masked?.body.input as string;
    const split = Math.floor(token.length / 2);
    const argument = JSON.stringify({ value: token });
    const events: ResponsesEvent[] = [
      {
        type: 'response.output_text.delta',
        item_id: 'a',
        content_index: 0,
        delta: `中文 ${token.slice(0, split)}`,
      },
      { type: 'response.output_text.delta', item_id: 'b', content_index: 0, delta: '另一条' },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'c',
        delta: argument.slice(0, 15),
      },
      {
        type: 'response.output_text.delta',
        item_id: 'a',
        content_index: 0,
        delta: token.slice(split),
      },
      { type: 'response.function_call_arguments.delta', item_id: 'c', delta: argument.slice(15) },
      { type: 'response.function_call_arguments.done', item_id: 'c', arguments: argument },
      {
        type: 'response.completed',
        response: {
          output: [
            { type: 'function_call', arguments: argument },
            { type: 'message', content: [{ text: token }] },
          ],
        },
      },
    ];
    const out = await restored(events, masked?.values ?? new Map(), true);
    expect(
      out
        .filter((event) => event.type === 'response.output_text.delta' && event.item_id === 'a')
        .map((event) => event.delta)
        .join(''),
    ).toBe(`中文 ${value}`);
    const args = out
      .filter((event) => event.type === 'response.function_call_arguments.delta')
      .map((event) => event.delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ value });
    expect(
      JSON.parse(out.find((event) => event.type.endsWith('arguments.done'))?.arguments as string),
    ).toEqual({ value });
    expect(JSON.stringify(out.at(-1))).not.toContain(token);
    expect(out.find((event) => event.item_id === 'b')?.delta).toBe('另一条');
  });

  it.each(['response.completed', 'response.failed', 'response.incomplete'])(
    '未完成前缀在 %s 前冲出',
    async (type) => {
      const masked = await masker().prepare(request(key), []);
      const out = await restored(
        [{ type: 'response.output_text.delta', item_id: 'a', delta: 'text {{SE' }, { type }],
        masked?.values ?? new Map(),
      );
      expect(
        out
          .slice(0, -1)
          .map((event) => event.delta)
          .join(''),
      ).toBe('text {{SE');
      expect(out.at(-1)?.type).toBe(type);
    },
  );
});
