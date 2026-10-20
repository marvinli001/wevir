// 像密钥的内容（AGENTS.md 规则 5）：记忆拒绝保存命中的内容，任务回顾导出前把命中的片段换掉（ADR-0012 决策 11）。只是正则检查，
// 认得出的只有下面这几种常见写法，不能保证没有遗漏。

/** 私钥、OpenAI / Anthropic 风格的 `sk-` 令牌、GitHub 令牌、AWS 访问密钥、Bearer 令牌、Google API Key、Slack 令牌。 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
];

/** 私钥要连同正文一起换掉：从 BEGIN 到 END（没有 END 时到文本结尾）。 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export const REDACTED = '[REDACTED]';

/** 文本里有没有像密钥的内容。 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** 把像密钥的片段换成 `[REDACTED]`，返回结果与替换的次数。 */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let result = text.replace(PRIVATE_KEY_BLOCK, () => {
    count += 1;
    return REDACTED;
  });
  for (const pattern of SECRET_PATTERNS.slice(1)) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );
    result = result.replace(global, () => {
      count += 1;
      return REDACTED;
    });
  }
  return { text: result, count };
}
