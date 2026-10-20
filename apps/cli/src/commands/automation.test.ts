import { beforeEach, describe, expect, it } from 'vitest';
import { describeError } from '../errors.js';
import { setLocale } from '../i18n/index.js';
import { run, useTempDir } from '../test-utils.js';
import {
  joinMonthlyArgs,
  parseCheck,
  parseDays,
  parseSchedule,
  requireAutomations,
  scheduleLabel,
} from './automation.js';

const tempDir = useTempDir();

beforeEach(() => setLocale('zh'));

describe('计划选项', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');

  it('换成协议的计划；没给时为 undefined', () => {
    expect(parseSchedule({}, now)).toBeUndefined();
    expect(parseSchedule({ manual: true }, now)).toEqual({ kind: 'manual' });
    expect(parseSchedule({ every: '45' }, now)).toEqual({ kind: 'interval', minutes: 45 });
    expect(parseSchedule({ daily: '7:05' }, now)).toEqual({ kind: 'daily', time: '07:05' });
    expect(parseSchedule({ daily: '09:00', days: 'wed,mon,mon' }, now)).toEqual({
      kind: 'daily',
      time: '09:00',
      weekdays: [1, 3],
    });
    // 七天都选等于每天。
    expect(parseSchedule({ daily: '09:00', days: 'weekdays,weekends' }, now)).toEqual({
      kind: 'daily',
      time: '09:00',
    });
    expect(parseSchedule({ monthly: '31 23:59' }, now)).toEqual({
      kind: 'monthly',
      day: 31,
      time: '23:59',
    });
    expect(parseSchedule({ once: '2026-10-21T09:30:00+08:00' }, now)).toEqual({
      kind: 'once',
      at: '2026-10-21T01:30:00.000Z',
    });
    const local = parseSchedule({ once: '2026-10-21 09:30' }, now);
    expect(local).toEqual({ kind: 'once', at: new Date('2026-10-21T09:30').toISOString() });
  });

  it('星期：英文名、数字、weekdays / weekends', () => {
    expect(parseDays('Sun,saturday,3')).toEqual([0, 3, 6]);
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(() => parseDays('7')).toThrow('无法识别的星期：7');
    expect(() => parseDays(',')).toThrow('无法识别的星期');
  });

  it('--monthly <日> <HH:MM> 两个词并成一个值，其他参数不动', () => {
    expect(joinMonthlyArgs(['--monthly', '15', '09:00', 'hello'])).toEqual([
      '--monthly=15 09:00',
      'hello',
    ]);
    expect(joinMonthlyArgs(['--monthly', '15 09:00', 'hello'])).toEqual([
      '--monthly',
      '15 09:00',
      'hello',
    ]);
    expect(joinMonthlyArgs(['--monthly', '15', 'hello'])).toEqual(['--monthly', '15', 'hello']);
  });

  it('计划的说法', () => {
    expect(scheduleLabel({ kind: 'manual' })).toBe('手动运行');
    expect(scheduleLabel({ kind: 'interval', minutes: 90 })).toBe('每 90 分钟');
    expect(scheduleLabel({ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe(
      '工作日 09:00',
    );
    expect(scheduleLabel({ kind: 'daily', time: '09:00', weekdays: [1, 3] })).toBe(
      '每周一、周三 09:00',
    );
    expect(scheduleLabel({ kind: 'monthly', day: 1, time: '10:00' })).toBe('每月 1 日 10:00');
    setLocale('en');
    expect(scheduleLabel({ kind: 'interval', minutes: 1 })).toBe('Every minute');
    expect(scheduleLabel({ kind: 'daily', time: '09:00', weekdays: [0, 6] })).toBe(
      'Every Sun, Sat at 09:00',
    );
  });
});

describe('检查脚本选项', () => {
  it('换成协议的检查脚本；默认按退出码', () => {
    expect(parseCheck({})).toBeUndefined();
    expect(parseCheck({ check: ' ./has-news.sh ' })).toEqual({
      command: './has-news.sh',
      wake: 'exit_code',
    });
    expect(
      parseCheck({ check: 'gh pr checks 42', wake: 'output-changed', checkTimeout: '30' }),
    ).toEqual({ command: 'gh pr checks 42', wake: 'output_changed', timeoutSeconds: 30 });
  });

  it('不合法时说明原因', () => {
    expect(() => parseCheck({ wake: 'exit-code' })).toThrow('--wake 与 --check-timeout 需要');
    expect(() => parseCheck({ check: '  ' })).toThrow('检查命令为空');
    expect(() => parseCheck({ check: 'x', wake: 'sometimes' })).toThrow('未知唤醒规则');
    expect(() => parseCheck({ check: 'x', checkTimeout: '601' })).toThrow('1 到 600');
  });

  it('--session 与项目、模型选项冲突', async () => {
    const result = await run(
      ['automation', 'create', '--title', 'x', '--session', 'ses_1', '--project', '.', 'y'],
      { home: tempDir() },
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain('--session');
    expect(result.err).toContain('--project');
  });
});

describe('Host 版本', () => {
  it('Host 没有 automations 功能时说明需要升级', () => {
    const old = { supports: () => false, hello: { hostVersion: '0.9.0' } } as unknown as Parameters<
      typeof requireAutomations
    >[0];
    let thrown: unknown;
    try {
      requireAutomations(old);
    } catch (error) {
      thrown = error;
    }
    expect(describeError(thrown)).toEqual({
      message: 'Host 0.9.0 不支持自动化',
      hint: '升级 Wevir Host（需要协议 0.66.0）',
    });
    const current = {
      supports: () => true,
      hello: { hostVersion: '1.0.0' },
    } as unknown as Parameters<typeof requireAutomations>[0];
    expect(() => requireAutomations(current)).not.toThrow();
  });
});

describe('帮助', () => {
  it('总帮助与 automation 组列出全部子命令', async () => {
    const home = tempDir();
    const main = await run(['--help'], { home });
    expect(main.out).toContain('自动化\n');
    for (const usage of [
      'wevir automation list [--json]',
      'wevir automation show <ID> [--json]',
      'wevir automation create --title <名称> [选项] "<指令>"',
      'wevir automation update <ID> [选项]',
      'wevir automation enable <ID>',
      'wevir automation disable <ID>',
      'wevir automation run <ID> [--json]',
      'wevir automation test-check <ID>',
      'wevir automation delete <ID>',
    ]) {
      expect(main.out).toContain(usage);
    }
    const create = await run(['automation', 'create', '--help'], { home, lang: 'en' });
    expect(create.code).toBe(0);
    expect(create.out).toContain('--monthly <day> <HH:MM>');
    expect(create.out).toContain('--check <command>');
    expect(create.out).toContain('--session <session ID>');
    const unknown = await run(['automation', 'pause', 'x'], { home });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('未知命令：wevir automation pause');
  });

  it('Host 没有运行时提示 wevir host start', async () => {
    const result = await run(['automation', 'list'], { home: tempDir() });
    expect(result.code).toBe(1);
    expect(result.err).toContain('下一步：运行 wevir host start');
  });
});
