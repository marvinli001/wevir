// 回顾的脱敏（ADR-0012 决策 11）：把所有文本字段里像密钥的片段换成 `[REDACTED]`。沿用记忆的密钥检查（secret-patterns.ts），
// 只是正则检查，不能保证没有遗漏。

import type { SessionRetro } from '@wevir/protocol';
import { redactSecrets } from '../secret-patterns.js';

/** 深拷贝一份回顾，所有字符串都过一遍；返回替换的次数。ID、提交号、时刻也是字符串，但它们不会命中这些规则。 */
export function redactRetro(retro: SessionRetro): { retro: SessionRetro; count: number } {
  let count = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactSecrets(value);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { retro: walk(retro) as SessionRetro, count };
}
