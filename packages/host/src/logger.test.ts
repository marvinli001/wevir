import { readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostError } from './errors.js';
import { createLogger, LOG_FILE, REDACTED, ROTATED_LOG_FILE, redact } from './logger.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const fixedNow = () => new Date('2026-10-13T00:00:00.000Z');

function lines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, LOG_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('JSON 行追加到 <dir>/host.log（目录 0700、文件 0600），带 ts、level、msg 与固定字段', () => {
    const dir = join(tempDir(), 'logs');
    const logger = createLogger({ dir, base: { pid: 7 }, now: fixedNow });
    logger.info('host ready', { url: 'ws://127.0.0.1:1/' });
    logger.close();
    const second = createLogger({ dir, now: fixedNow });
    second.warn('again');
    second.close();
    expect(lines(dir)).toEqual([
      {
        ts: '2026-10-13T00:00:00.000Z',
        level: 'info',
        msg: 'host ready',
        pid: 7,
        url: 'ws://127.0.0.1:1/',
      },
      { ts: '2026-10-13T00:00:00.000Z', level: 'warn', msg: 'again' },
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, LOG_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it('按级别过滤；字段不能盖掉 ts / level / msg', () => {
    const out: string[] = [];
    const logger = createLogger({ level: 'warn', mirror: (line) => out.push(line), now: fixedNow });
    logger.debug('d');
    logger.info('i');
    logger.warn('w', { level: 'fake', msg: 'fake', ts: 'fake', extra: 1 });
    logger.error('e');
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { ts: '2026-10-13T00:00:00.000Z', level: 'warn', msg: 'w', extra: 1 },
      { ts: '2026-10-13T00:00:00.000Z', level: 'error', msg: 'e' },
    ]);
  });

  it('令牌与密钥脱敏：按字段名整体替换，登记过的值在任何字符串里替换', () => {
    const out: string[] = [];
    const logger = createLogger({ mirror: (line) => out.push(line) });
    const token = 'tok_0123456789abcdefghij';
    logger.addSecret(token);
    logger.info(`connected with ${token}`, {
      token,
      apiKey: 'sk-1',
      nested: { api_key: 'sk-2', Authorization: 'Bearer x', list: [{ secretRef: 'p' }] },
      url: `ws://127.0.0.1:1/?t=${token}`,
      error: new Error(`bad token ${token}`),
    });
    const text = out.join('\n');
    expect(text).not.toContain(token);
    expect(text).not.toContain('sk-1');
    expect(text).not.toContain('sk-2');
    const line = JSON.parse(out[0] as string);
    expect(line.msg).toBe(`connected with ${REDACTED}`);
    expect(line.token).toBe(REDACTED);
    expect(line.nested).toEqual({
      api_key: REDACTED,
      Authorization: REDACTED,
      list: [{ secretRef: REDACTED }],
    });
    expect(line.url).toBe(`ws://127.0.0.1:1/?t=${REDACTED}`);
    expect(line.error).toMatchObject({ name: 'Error', message: `bad token ${REDACTED}` });
  });

  it('host.log 超过上限时改名成 host.1.log（覆盖上一份）再开新的；被截短过的照实际大小算', () => {
    const dir = join(tempDir(), 'logs');
    const logger = createLogger({ dir, now: fixedNow, maxBytes: 200 });
    for (let index = 0; index < 3; index += 1) logger.info(`first ${index}`);
    expect(readdirSync(dir)).toEqual([LOG_FILE]);
    logger.info('second 0');
    expect(readdirSync(dir).sort()).toEqual([ROTATED_LOG_FILE, LOG_FILE].sort());
    expect(readFileSync(join(dir, ROTATED_LOG_FILE), 'utf8')).toContain('first 2');
    expect(lines(dir).map((line) => line.msg)).toEqual(['second 0']);
    for (let index = 1; index < 4; index += 1) logger.info(`second ${index}`);
    expect(readFileSync(join(dir, ROTATED_LOG_FILE), 'utf8')).not.toContain('first');

    // 存储页清理日志：截成空的之后不因旧的计数立刻轮转。
    truncateSync(join(dir, LOG_FILE), 0);
    const rotated = readFileSync(join(dir, ROTATED_LOG_FILE), 'utf8');
    logger.info('after clean');
    expect(lines(dir).map((line) => line.msg)).toEqual(['after clean']);
    expect(readFileSync(join(dir, ROTATED_LOG_FILE), 'utf8')).toBe(rotated);

    // 重新打开时接着算已有的大小。
    logger.close();
    const reopened = createLogger({ dir, now: fixedNow, maxBytes: 200 });
    for (let index = 0; index < 3; index += 1) reopened.info(`third ${index}`);
    reopened.close();
    expect(readFileSync(join(dir, ROTATED_LOG_FILE), 'utf8')).toContain('after clean');
  });

  it('写日志失败不抛出', () => {
    const logger = createLogger({
      mirror: () => {
        throw new Error('broken pipe');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });
});

describe('redact', () => {
  it('服务账号 JSON 与私钥字段整体遮掉', () => {
    expect(
      redact({ serviceAccountJson: 'fake-json', private_key: 'fake-key', privateKey: 'fake-key' }),
    ).toEqual({ serviceAccountJson: REDACTED, private_key: REDACTED, privateKey: REDACTED });
  });
  it('展开 Error（含 HostError 的 code 与 data），处理循环引用与 bigint', () => {
    const error = new HostError('SESSION_NOT_FOUND', 'session ses_1 not found');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const shared = { x: 1 };
    expect(redact({ error, circular, n: 10n, pair: [shared, shared] })).toMatchObject({
      error: { name: 'HostError', message: 'session ses_1 not found', code: 'SESSION_NOT_FOUND' },
      circular: { a: 1, self: '[Circular]' },
      n: '10',
      pair: [{ x: 1 }, { x: 1 }],
    });
  });
});
