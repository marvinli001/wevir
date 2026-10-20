import type { ProviderProfile, UsageTiming } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import {
  approxNote,
  averageFirstToken,
  bucketEdges,
  bucketLabel,
  cacheHitRate,
  createThrottle,
  filterProviders,
  formatAxis,
  formatCost,
  formatCostAxis,
  formatInteger,
  formatPercent,
  formatSeconds,
  formatSpeed,
  formatTokensApprox,
  formatTokensFit,
  labelStride,
  localMidnight,
  niceTicks,
  pageCount,
  providerLogoOf,
  providerTitle,
  selectModel,
  selectProvider,
  sourceDisplay,
  speedOf,
  timingSpeed,
  toFilter,
  totalTokens,
  usageAvailability,
} from './usage-model';

/** Intl 在数字与单位之间用不换行空格（U+00A0 / U+202F），比较时都当普通空格。 */
const plain = (text: string | undefined) => text?.replace(/\s/g, ' ');

const tokens = { input: 100, output: 50, cacheRead: 300, cacheWrite: 100, reasoning: 20 };

describe('功能门控', () => {
  it('没连上是 pending，Host 声明 usage_stats 才可用', () => {
    expect(usageAvailability(undefined)).toBe('pending');
    expect(usageAvailability({})).toBe('unsupported');
    expect(usageAvailability({ usage_stats: false })).toBe('unsupported');
    expect(usageAvailability({ usage_stats: true })).toBe('ready');
  });
});

describe('分桶边界', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('今天：本地零点到下一个零点，每小时一桶', () => {
    process.env.TZ = 'Asia/Shanghai';
    const now = new Date(2026, 9, 20, 15, 42);
    const edges = bucketEdges('today', now);
    expect(edges).toHaveLength(25);
    expect(edges[0]).toBe(new Date(2026, 9, 20).getTime());
    expect(edges.at(-1)).toBe(new Date(2026, 9, 21).getTime());
    expect(edges[1]).toBe(new Date(2026, 9, 20, 1).getTime());
  });

  it('近 N 天：到今天为止的 N 天，边界是各天的本地零点', () => {
    process.env.TZ = 'Asia/Shanghai';
    const now = new Date(2026, 9, 20, 9);
    const week = bucketEdges('7d', now);
    expect(week).toHaveLength(8);
    expect(week[0]).toBe(new Date(2026, 9, 14).getTime());
    expect(week.at(-1)).toBe(new Date(2026, 9, 21).getTime());
    expect(bucketEdges('30d', now)).toHaveLength(31);
    expect(bucketEdges('90d', now)).toHaveLength(91);
  });

  it('跨夏令时：天的边界仍是零点，那天的小时桶是 23 或 25 个，全部严格升序', () => {
    process.env.TZ = 'America/New_York';
    // 2026-03-08 春季拨快、2026-11-01 秋季拨慢。
    const spring = bucketEdges('today', new Date(2026, 2, 8, 12));
    const fall = bucketEdges('today', new Date(2026, 10, 1, 12));
    expect(spring).toHaveLength(24);
    expect(fall).toHaveLength(26);
    const days = bucketEdges('7d', new Date(2026, 2, 10, 12));
    for (const edge of days) {
      const at = new Date(edge);
      expect([at.getHours(), at.getMinutes()]).toEqual([0, 0]);
    }
    expect((days[5] ?? 0) - (days[4] ?? 0)).toBe(23 * 3_600_000);
    for (const edges of [spring, fall, days]) {
      for (let index = 1; index < edges.length; index++) {
        expect(edges[index] ?? 0).toBeGreaterThan(edges[index - 1] ?? 0);
      }
    }
    expect(localMidnight(new Date(2026, 10, 1, 23), 1)).toBe(new Date(2026, 10, 2).getTime());
  });
});

describe('筛选', () => {
  it('换服务商清掉模型', () => {
    const full = { providerId: 'p1', model: 'm' } as const;
    expect(selectProvider('p2')).toEqual({ providerId: 'p2' });
    expect(selectProvider(undefined)).toEqual({});
    expect(selectModel(full, undefined)).toEqual({ providerId: 'p1' });
    expect(selectModel({}, 'x')).toEqual({ model: 'x' });
  });

  it('转成 Host 的筛选，什么都没选时省略', () => {
    expect(toFilter({})).toBeUndefined();
    expect(toFilter({ providerId: 'p1', model: 'm' })).toEqual({
      providerIds: ['p1'],
      models: ['m'],
    });
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
  });
});

describe('token 与速度', () => {
  it('总量是四项之和，命中率按输入侧算', () => {
    expect(totalTokens(tokens)).toBe(550);
    expect(cacheHitRate(tokens)).toBeCloseTo(0.6);
    expect(cacheHitRate({ ...tokens, input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it('耗时不到 1 秒或输出不到 200 token 不算速度', () => {
    expect(speedOf(1000, 10_000)).toBe(100);
    expect(speedOf(1000, 999)).toBeUndefined();
    expect(speedOf(199, 10_000)).toBeUndefined();
    expect(speedOf(1000, undefined)).toBeUndefined();
    const timing: UsageTiming = {
      timedRequests: 3,
      outputTokens: 3000,
      durationMs: 60_000,
      firstTokenCount: 2,
      firstTokenMs: 3000,
    };
    expect(timingSpeed(timing)).toBe(50);
    expect(averageFirstToken(timing)).toBe(1500);
    expect(averageFirstToken({ ...timing, firstTokenCount: 0, firstTokenMs: 0 })).toBeUndefined();
  });
});

describe('数字的写法', () => {
  // 每种界面语言的约数（Intl 的紧凑写法），中日韩用万 / 亿（萬 / 億、만 / 억）。
  const APPROX: Record<string, [string, string, string]> = {
    en: ['12.35K', '228M', '32.5B'],
    'zh-CN': ['1.23万', '2.28亿', '325亿'],
    'zh-TW': ['1.23萬', '2.28億', '325億'],
    fr: ['12,35 k', '228 M', '32,5 Md'],
    de: ['12.345', '228 Mio.', '32,5 Mrd.'],
    it: ['12,35K', '228 Mln', '32,5 Mld'],
    es: ['12,35 mil', '228 M', '32,5 mil M'],
    ja: ['1.23万', '2.28億', '325億'],
    ko: ['1.23만', '2.28억', '325억'],
    ru: ['12,35 тыс.', '228 млн', '32,5 млрд'],
  };

  it('十种界面语言的约数都核对过', () => {
    expect(Object.keys(APPROX).sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      expect(
        [12_345, 228_000_000, 32_500_000_000].map((value) =>
          plain(formatTokensApprox(value, locale)),
        ),
        locale,
      ).toEqual(APPROX[locale]);
    }
  });

  it('完整整数按语言分组，约数与完整写法相同或不到一万时不另写', () => {
    expect(formatInteger(228_123_456, 'en')).toBe('228,123,456');
    expect(plain(formatInteger(228_123_456, 'fr'))).toBe('228 123 456');
    expect(formatInteger(228_123_456, 'de')).toBe('228.123.456');
    expect(approxNote(228_123_456, 'zh-CN')).toBe('2.28亿');
    expect(approxNote(5000, 'zh-CN')).toBeUndefined();
    expect(approxNote(5000, 'en')).toBeUndefined();
    expect(approxNote(12_345, 'de')).toBeUndefined();
    expect(approxNote(12_345, 'en')).toBe('12.35K');
  });

  it('放不下时写约数', () => {
    expect(formatTokensFit(123_456_789, 'en')).toBe('123,456,789');
    expect(formatTokensFit(12_345_678_901, 'en')).toBe('12.35B');
    expect(formatTokensFit(12_345_678_901, 'zh-CN')).toBe('123.46亿');
  });

  it('坐标轴用紧凑写法', () => {
    expect(formatAxis(50_000, 'zh-CN')).toBe('5万');
    expect(formatAxis(50_000, 'en')).toBe('50K');
    expect(formatAxis(0, 'en')).toBe('0');
  });

  it('成本：1 美元以上两位小数，以下固定四位，很小的写“<”', () => {
    expect(formatCost(84.159, 'en')).toBe('$84.16');
    expect(formatCost(84.159, 'zh-CN')).toBe('$84.16');
    expect(plain(formatCost(84.159, 'fr'))).toBe('84,16 $');
    expect(formatCost(0.01234, 'en')).toBe('$0.0123');
    expect(formatCost(0.5, 'en')).toBe('$0.5000');
    expect(formatCost(0.003, 'en')).toBe('$0.0030');
    expect(formatCost(0, 'en')).toBe('$0.0000');
    expect(formatCost(0.00001, 'en')).toBe('< $0.0001');
    expect(formatCostAxis(0, 'en')).toBe('$0');
    expect(formatCostAxis(0.02, 'en')).toBe('$0.02');
    expect(formatCostAxis(40, 'en')).toBe('$40');
  });

  it('百分比、秒数与速度', () => {
    expect(formatPercent(0.6123, 'en')).toBe('61.2%');
    expect(plain(formatSeconds(1234, 'en'))).toBe('1.2 sec');
    expect(formatSeconds(1234, 'zh-CN')).toBe('1.2秒');
    expect(formatSeconds(2000, 'zh-CN')).toBe('2.0秒');
    expect(formatSpeed(42.54, 'en')).toBe('43 tok/s');
    expect(formatSpeed(undefined, 'en')).toBeUndefined();
  });
});

describe('时间与坐标轴', () => {
  it('按小时是 HH:mm，按天是 MM/DD（随语言）', () => {
    const at = new Date(2026, 9, 5, 7).getTime();
    expect(bucketLabel(at, 'today', 'zh-CN')).toBe('07:00');
    expect(bucketLabel(at, 'today', 'en')).toBe('07:00');
    expect(bucketLabel(at, '7d', 'zh-CN')).toBe('10/05');
    expect(bucketLabel(at, '7d', 'de')).toBe('05.10.');
  });

  it('标签间隔与刻度', () => {
    expect(labelStride(24, 1000)).toBe(2);
    expect(labelStride(7, 1000)).toBe(1);
    expect(labelStride(90, 600)).toBe(9);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceTicks(7_400_000)).toEqual([0, 2_000_000, 4_000_000, 6_000_000, 8_000_000]);
    expect(niceTicks(0.031)).toEqual([0, 0.01, 0.02, 0.03, 0.04]);
  });
});

describe('来源', () => {
  it('订阅来源用软件名与标志，API 类按种类', () => {
    expect(sourceDisplay('chatgpt')).toEqual({ name: 'Codex', logo: 'codex' });
    expect(sourceDisplay('claude')).toEqual({ name: 'Claude', logo: 'claude' });
    expect(sourceDisplay('deepseek-official').logo).toBe('deepseek');
    expect(sourceDisplay('openai-compatible').logo).toBeUndefined();
  });

  it('服务商的标志：Provider 还在时按地址认，删了按来源', () => {
    const providers = [
      { id: 'p_kimi', kind: 'openai-compatible', baseURL: 'https://api.moonshot.cn/v1' },
    ] as unknown as ProviderProfile[];
    expect(providerLogoOf('p_kimi', 'openai-compatible', providers)).toBe('kimi');
    expect(providerLogoOf('p_gone', 'claude', providers)).toBe('claude');
    expect(providerLogoOf('p_gone', 'openai-compatible', providers)).toBeUndefined();
  });

  it('筛选列出添加的连接：顺序同模型选择，停用的只在有用量时列出；订阅用来源名', () => {
    const providers = [
      { id: 'kimi', kind: 'openai-compatible', displayName: 'Kimi' },
      { id: 'off', kind: 'openai-compatible', displayName: 'Off', enabled: false },
      { id: 'used', kind: 'openai-compatible', displayName: 'Used', enabled: false },
      { id: 'claude', kind: 'claude', displayName: 'Claude Agent' },
    ] as unknown as ProviderProfile[];
    const listed = filterProviders(providers, [{ id: 'used' }, { id: 'gone' }]);
    expect(listed.map((provider) => provider.id)).toEqual(['claude', 'kimi', 'used']);
    expect(listed.map(providerTitle)).toEqual(['Claude', 'Kimi', 'Used']);
  });
});

describe('重读的节流', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('空闲时马上读，间隔内的多次合成一次，排在间隔到时', () => {
    const run = vi.fn();
    const throttle = createThrottle(run, 2000);
    throttle.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    throttle.trigger();
    throttle.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1499);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    throttle.trigger();
    expect(run).toHaveBeenCalledTimes(3);
    throttle.trigger();
    throttle.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
