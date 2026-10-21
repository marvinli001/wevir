// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex codex-rs/rmcp-client/src/www_authenticate.rs，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。
// 修改：Rust 改为 TypeScript；不只认 `insufficient_scope`，返回 Bearer 挑战里的 `resource_metadata`、`scope` 与 `error`
// （MCP Authorization 的发现与 scope 选择要用前两项）。

/** 一个 Bearer 挑战里 MCP OAuth 用到的参数。重复出现的参数作废（RFC 6750 §3：每个参数最多一次）。 */
export interface BearerChallenge {
  resourceMetadata?: string;
  /** 空格分隔的 scope；不合 RFC 6750 语法时省略。 */
  scope?: string;
  error?: string;
}

const PARAMS = ['resource_metadata', 'scope', 'error'] as const;
type Param = (typeof PARAMS)[number];

/**
 * 从 `WWW-Authenticate` 的全部取值里找第一个 Bearer 挑战。RFC 9110 §11.2：参数值是 token 或 quoted-string，quoted-string 里的
 * `\x` 换成 `x`；同一个头可以有用逗号隔开的多个挑战。
 */
export function parseBearerChallenge(
  header: string | readonly string[] | undefined,
): BearerChallenge | undefined {
  for (const value of typeof header === 'string' ? [header] : (header ?? [])) {
    const found = parseHeader(value);
    if (found) return found;
  }
  return undefined;
}

function parseHeader(header: string): BearerChallenge | undefined {
  const segments = splitUnquoted(header);
  if (!segments) return undefined;
  let current: Map<Param, string | null> | undefined;
  for (const segment of segments) {
    const param = parseAuthParam(segment);
    if (param) {
      if (current) add(current, param[0], param[1]);
      continue;
    }
    if (current) return finish(current);
    const start = parseChallengeStart(segment);
    if (!start) return undefined;
    if (start.scheme.toLowerCase() === 'bearer') {
      current = new Map();
      if (start.param) add(current, start.param[0], start.param[1]);
    }
  }
  return current ? finish(current) : undefined;
}

function add(challenge: Map<Param, string | null>, name: string, value: string | undefined): void {
  const key = PARAMS.find((item) => item === name.toLowerCase());
  if (key === undefined) return;
  // 重复或解析失败的参数记成 null，视为没给。
  challenge.set(key, challenge.has(key) || value === undefined ? null : value);
}

function finish(challenge: Map<Param, string | null>): BearerChallenge {
  const resourceMetadata = challenge.get('resource_metadata');
  const scope = challenge.get('scope');
  const error = challenge.get('error');
  return {
    ...(typeof resourceMetadata === 'string' && { resourceMetadata }),
    ...(typeof scope === 'string' && validScope(scope) && { scope }),
    ...(typeof error === 'string' && { error }),
  };
}

function parseChallengeStart(
  segment: string,
): { scheme: string; param?: [string, string | undefined] } | undefined {
  const trimmed = segment.trim();
  const space = trimmed.search(/\s/);
  const scheme = space < 0 ? trimmed : trimmed.slice(0, space);
  if (!isToken(scheme)) return undefined;
  const param = space < 0 ? undefined : parseAuthParam(trimmed.slice(space));
  return { scheme, ...(param && { param }) };
}

function parseAuthParam(segment: string): [string, string | undefined] | undefined {
  const trimmed = segment.trim();
  const equals = trimmed.indexOf('=');
  if (equals < 0) return undefined;
  const name = trimmed.slice(0, equals).trim();
  if (!isToken(name)) return undefined;
  return [name, parseValue(trimmed.slice(equals + 1).trim())];
}

function parseValue(value: string): string | undefined {
  if (!value.startsWith('"')) return isToken(value) ? value : undefined;
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  let out = '';
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (char === '\\') {
      index += 1;
      if (index >= inner.length) return undefined;
      out += inner[index];
    } else out += char;
  }
  return out;
}

/** 按不在引号里的 `,` 与 `;` 切开；引号没闭合时整体作废。 */
function splitUnquoted(header: string): string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if ((char === ',' || char === ';') && !quoted) {
      segments.push(header.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return undefined;
  segments.push(header.slice(start));
  return segments;
}

/** RFC 6750 §3：scope-token 是 %x21 / %x23-5B / %x5D-7E，用单个空格隔开。 */
function validScope(scope: string): boolean {
  return scope.split(' ').every((token) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(token));
}

function isToken(value: string): boolean {
  return /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(value);
}
