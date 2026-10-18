// SPDX-License-Identifier: MIT
// OpenCode 的上游（opencode-event-mapping.md §2.4）：opencode 后面接着的模型服务（OpenCode Zen / Go、OpenAI、GitHub Copilot、
// Anthropic…），一个 opencode 同时接着好几家。应用内登录要让用户选“接哪一家、用哪种方式”，这里把本机服务器的两个接口合成
// 一张表：`provider.list` 的全部上游与 `connected`，`provider.auth` 里各上游的登录方式（只有 OAuth 或要填额外信息的上游才有
// 条目，其余是 opencode 的默认——填 API Key）。方式带必填的额外信息（GitLab 的实例地址、Cloudflare 的账号 ID…）的不在应用内
// 提供，用户仍可在终端里 `opencode auth login`。

import type { ProviderAuthMethod, ProviderListResponse } from './sdk.js';

/** 一种接上游的方式。 */
export interface UpstreamMethod {
  /** `oauth`：浏览器授权或设备码（接上后由服务器等回调）；`api_key`：填 Key。 */
  type: 'oauth' | 'api_key';
  /** opencode 给的方式名（如 “ChatGPT Pro/Plus (headless)”），产品名，原样显示。 */
  label: string;
  /** 这种方式的 ID（协议的 `option`）：opencode 里的序号（`provider.auth` 数组里的位置）写成字符串；默认的 API Key 方式是 `default`。 */
  option: string;
  /** opencode 里这种方式的序号（`provider.oauth.authorize` 的 `method`）；默认的 API Key 方式没有。 */
  index?: number;
}

export interface OpenCodeUpstream {
  /** opencode 的上游 ID（`openai`、`github-copilot`、`opencode`…）。 */
  id: string;
  name: string;
  /** 接上了：凭据在 opencode 里、环境变量里，或是 OpenCode Zen 的免登录模型。 */
  connected: boolean;
  /** 常用的（opencode 自己列在最前面的几家，和有 OAuth 登录的）：界面可以先只列这些。 */
  featured: boolean;
  methods: UpstreamMethod[];
}

/** opencode 自己的登录菜单把这几家排在前面（`auth login`）；OpenCode Go 是 Zen 的订阅，紧跟其后。 */
const PRIORITY = [
  'opencode',
  'opencode-go',
  'anthropic',
  'github-copilot',
  'openai',
  'google',
  'openrouter',
  'vercel',
] as const;

/** 默认的 API Key 方式（`provider.auth` 里没有这个上游时，opencode 的做法）。 */
export const DEFAULT_OPTION = 'default';

type Prompt = NonNullable<ProviderAuthMethod['prompts']>[number];

function applies(prompt: Prompt, inputs: Record<string, string>): boolean {
  if (prompt.when === undefined) return true;
  const actual = inputs[prompt.when.key];
  return prompt.when.op === 'eq' ? actual === prompt.when.value : actual !== prompt.when.value;
}

/**
 * 方式要问的额外信息，取默认值：选择题取第一项（GitHub Copilot 的 “GitHub.com / Enterprise” 取 GitHub.com），条件不成立的题
 * 跳过。还剩下必须自己填的文字题（实例地址、账号 ID…）时返回 undefined：应用内不提供。
 */
export function defaultInputs(
  prompts: ProviderAuthMethod['prompts'],
): Record<string, string> | undefined {
  const inputs: Record<string, string> = {};
  for (const prompt of prompts ?? []) {
    if (!applies(prompt, inputs)) continue;
    if (prompt.type === 'select') {
      const first = prompt.options[0];
      if (first === undefined) return undefined;
      inputs[prompt.key] = first.value;
    } else {
      return undefined;
    }
  }
  return inputs;
}

/** 一个上游在应用内能用的方式。 */
export function upstreamMethods(methods: ProviderAuthMethod[] | undefined): UpstreamMethod[] {
  if (methods === undefined) return [{ type: 'api_key', label: 'API key', option: DEFAULT_OPTION }];
  return methods.flatMap((method, index) =>
    defaultInputs(method.prompts) === undefined
      ? []
      : [
          {
            type: method.type === 'oauth' ? ('oauth' as const) : ('api_key' as const),
            label: method.label,
            option: String(index),
            index,
          },
        ],
  );
}

/** 全部能在应用内接的上游：常用的在前（opencode 的顺序），其余按名字。 */
export function upstreamCatalog(
  list: ProviderListResponse,
  auth: Record<string, ProviderAuthMethod[]>,
): OpenCodeUpstream[] {
  const connected = new Set(list.connected);
  const rank = (id: string) => {
    const index = PRIORITY.indexOf(id as (typeof PRIORITY)[number]);
    return index < 0 ? PRIORITY.length : index;
  };
  return list.all
    .flatMap((provider): OpenCodeUpstream[] => {
      const methods = upstreamMethods(auth[provider.id]);
      if (methods.length === 0) return [];
      return [
        {
          id: provider.id,
          name: provider.name,
          connected: connected.has(provider.id),
          featured: rank(provider.id) < PRIORITY.length || methods.some((m) => m.type === 'oauth'),
          methods,
        },
      ];
    })
    .sort((left, right) => rank(left.id) - rank(right.id) || left.name.localeCompare(right.name));
}

/**
 * 授权说明里的设备码（opencode 的设备码方式把 “Enter code: ABCD-1234” 写在 `instructions` 里，GitHub Copilot 与 ChatGPT 的
 * 无头登录都是）；没有时 undefined——那是浏览器授权。
 */
export function deviceCode(instructions: string): string | undefined {
  return /\bcode\s*:\s*([A-Za-z0-9][A-Za-z0-9-]*)/iu.exec(instructions)?.[1];
}
