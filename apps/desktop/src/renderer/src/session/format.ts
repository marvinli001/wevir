import { t } from '@/i18n';

/** 时长：不到 10 秒保留一位小数，不到 1 分钟取整秒，再长写成“N 分 M 秒”。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return t('time.seconds', { n: Number(seconds.toFixed(1)) });
  if (seconds < 60) return t('time.seconds', { n: Math.floor(seconds) });
  const whole = Math.floor(seconds);
  return t('time.minutes', { m: Math.floor(whole / 60), s: whole % 60 });
}

/** 两个 ISO 时刻之间的毫秒数；缺一个时为 undefined。 */
export function between(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 工具参数等 unknown 值的展示文本：截断替身显示开头，其余 JSON 缩进两格。 */
export function formatJson(value: unknown): { text: string; truncatedFrom?: number } {
  if (isTruncatedJson(value)) return { text: value.preview, truncatedFrom: value.originalLength };
  if (typeof value === 'string') return { text: value };
  try {
    return { text: JSON.stringify(value, null, 2) ?? '' };
  } catch {
    return { text: String(value) };
  }
}

function isTruncatedJson(
  value: unknown,
): value is { $truncated: true; originalLength: number; preview: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { $truncated?: unknown }).$truncated === true &&
    typeof (value as { preview?: unknown }).preview === 'string'
  );
}
