// SPDX-License-Identifier: MIT
// `redactDiagnostics` 的规则改写自 pingdotgg/t3code packages/provider-core/src/server/failure.ts（`redactProviderFailureText`）、
// packages/provider-acp/src/server/stderr.ts（`sanitizeAcpStderrExcerpt`）
// 来源提交 67afdd56c7905e9df721c61f5795578bb8c27867、49d014245777bbf47756635886ddf0846d2330d3
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只取凭据键名（可带前缀的组合键名）后的值与 `Bearer` / `Basic` 凭据两类规则，接在 Wevir 的 `redactSecrets` 之后；不做
// 网址、主目录与控制字符的处理。文件其余部分（`SECRET_PATTERNS`、`looksLikeSecret`、`redactSecrets`）是 Wevir 的。
//
// 像密钥的内容（AGENTS.md 规则 5）：记忆拒绝保存命中的内容，任务回顾导出前把命中的片段换掉（ADR-0012 决策 11），引擎的 stderr
// 与错误原文进事件库之前也遮盖（`redactDiagnostics`）。只是正则检查，认得出的只有下面这几种常见写法，不能保证没有遗漏。放在这里
// 而不是 Host，是因为引擎适配器也要用；Host 经 host/src/secret-patterns.ts 转出。

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

/** `Bearer` / `Basic` 后面的凭据，不论长短（`SECRET_PATTERNS` 的 Bearer 只认 24 个字符以上的，那是为了检测时少误报）。 */
const AUTH_SCHEME_VALUE = /\b(Bearer|Basic)\s+[^\s,;"']+/giu;

/** 凭据类的键名，前面可以有别的词（`OPENAI_API_KEY`、`github_token`、`db-password`）。 */
const CREDENTIAL_KEY = String.raw`[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)`;

/** `"api_key": "…"`：带引号的键与值（JSON），只换值。 */
const QUOTED_CREDENTIAL = new RegExp(
  String.raw`(["']${CREDENTIAL_KEY}["']\s*:\s*["'])[^"']*(["'])`,
  'giu',
);

/** `OPENAI_API_KEY=…`、`password: …`：键名之后的值（引号括起的整段或到空白、逗号、分号为止），只换值；`Bearer …` 已在前面换过。 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`((?<![\w-])${CREDENTIAL_KEY}\b\s*[:=]\s*)(?!(?:Bearer|Basic)\s)(?:"[^"]*"|'[^']*'|[^\s,;]+)`,
  'giu',
);

/**
 * 诊断文本（引擎的 stderr、错误原文）的遮盖：`redactSecrets` 的几种令牌，加上 `Bearer` / `Basic` 后的凭据与凭据类键名后的值
 * （T3 Code 的 provider 错误与 ACP stderr 的遮盖，#23313、#24015）。宁可多遮：只用在给人看的诊断上，不用来判断“像不像密钥”。
 */
export function redactDiagnostics(text: string): string {
  return redactSecrets(text)
    .text.replace(AUTH_SCHEME_VALUE, `$1 ${REDACTED}`)
    .replace(QUOTED_CREDENTIAL, `$1${REDACTED}$2`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`);
}
