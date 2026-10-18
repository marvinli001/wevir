// 订阅来源（0.19.0，ADR-0005 补记 14）：模型选择与设置共用的纯逻辑——每种订阅叫什么、用哪个软件标志，一个 Provider 是不是
// 来自订阅、现在能不能选，订阅账号给人看的状态。API 类 Provider（DeepSeek 官方、OpenAI 兼容）不是来源，没有软件标志。

import {
  type AccountKind,
  type AccountState,
  type ProviderProfile,
  SUBSCRIPTION_KINDS,
} from '@wevir/protocol';
import type { ProviderLogoId } from '@/components/provider-logo';
import type { PlainMessageKey } from '@/i18n';

/** 订阅来源的固定顺序：设置里的格子与模型选择里的分组都按它排。ChatGPT 订阅跑在 Codex 上，界面上叫 Codex。 */
export const SOURCE_KINDS: readonly AccountKind[] = ['chatgpt', ...SUBSCRIPTION_KINDS];

export interface SourceInfo {
  kind: AccountKind;
  /** 软件名（品牌名，照原文）。 */
  name: PlainMessageKey;
  logo: ProviderLogoId;
}

export const SOURCES: Readonly<Record<AccountKind, SourceInfo>> = {
  chatgpt: { kind: 'chatgpt', name: 'source.codex', logo: 'codex' },
  claude: { kind: 'claude', name: 'source.claude', logo: 'claude' },
  cursor: { kind: 'cursor', name: 'source.cursor', logo: 'cursor' },
  opencode: {
    kind: 'opencode',
    name: 'source.opencode',
    logo: 'opencode',
  },
  workbuddy: { kind: 'workbuddy', name: 'source.workbuddy', logo: 'codebuddy' },
  grok: { kind: 'grok', name: 'source.grok', logo: 'grok' },
  antigravity: {
    kind: 'antigravity',
    name: 'source.antigravity',
    logo: 'antigravity',
  },
};

/**
 * 设置里的格子卡窄时两列、宽时三列，网格底是分隔线色：最后一行没排满，空位会露出这个底色。按来源个数补几格同底色的空格——
 * 两列与三列各缺几格不同，每个补位格带着它在哪个宽度下显示。
 */
export function tileFillers(count: number): { slot: number; base: boolean; sm: boolean }[] {
  const base = count % 2 === 0 ? 0 : 1;
  const sm = count % 3 === 0 ? 0 : 3 - (count % 3);
  return Array.from({ length: Math.max(base, sm) }, (_, index) => ({
    slot: index + 1,
    base: index < base,
    sm: index < sm,
  }));
}

export function isSourceKind(kind: string): kind is AccountKind {
  return (SOURCE_KINDS as readonly string[]).includes(kind);
}

/** Provider 来自哪个订阅；API 类 Provider 返回 undefined。 */
export function sourceOf(provider: Pick<ProviderProfile, 'kind'>): SourceInfo | undefined {
  return isSourceKind(provider.kind) ? SOURCES[provider.kind] : undefined;
}

/**
 * 模型选择里列不列这个 Provider：停用的不列；订阅来源要账号已登录（还没读到账号时照列，Provider 是登录过才建的）。
 */
export function isPickable(
  provider: ProviderProfile,
  accounts: readonly AccountState[] | undefined,
): boolean {
  if (provider.enabled === false) return false;
  if (!isSourceKind(provider.kind)) return true;
  const account = accounts?.find((candidate) => candidate.kind === provider.kind);
  return account === undefined || account.status === 'signed_in';
}

/** 模型选择里的顺序：订阅来源在前（按 `SOURCE_KINDS`），API 在后（保持 Host 给的顺序）。 */
export function pickerOrder<T extends Pick<ProviderProfile, 'kind'>>(providers: readonly T[]): T[] {
  const rank = (provider: T) => {
    const index = SOURCE_KINDS.indexOf(provider.kind as AccountKind);
    return index < 0 ? SOURCE_KINDS.length : index;
  };
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(({ provider }) => provider);
}

/**
 * Claude 在 Windows 上缺 Git for Windows 时 Host 给的状态（claude-event-mapping.md §2）：没装（`installed: false`）、没有安装命令、
 * 安装地址是 Git 的下载页；协议没有专门的字段，认这个地址。
 */
export const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/downloads/win';

/** 订阅格子与详情里的状态。`soon`：这个 Host 还没有这种订阅的引擎；`missing` 的 `requires`：缺的是 Git，不是软件本身。 */
export type SourcePhase =
  | { kind: 'soon' }
  | { kind: 'missing'; canInstall: boolean; requires?: 'git' }
  | { kind: 'installing'; percent: number | undefined }
  | { kind: 'signed_out'; signIn: 'in_app' | 'command' }
  | { kind: 'signing_in' }
  | { kind: 'signed_in'; plan: string | undefined };

export function sourcePhase(account: AccountState | undefined): SourcePhase {
  if (account === undefined) return { kind: 'soon' };
  if (account.installing !== undefined) {
    const { completedBytes, totalBytes } = account.installing;
    return {
      kind: 'installing',
      percent:
        totalBytes === undefined || totalBytes === 0
          ? undefined
          : Math.min(100, Math.round((completedBytes / totalBytes) * 100)),
    };
  }
  if (account.installed === false) {
    return {
      kind: 'missing',
      canInstall: account.canInstall === true,
      ...(account.kind === 'claude' &&
        account.installUrl === GIT_FOR_WINDOWS_URL && { requires: 'git' as const }),
    };
  }
  if (account.status === 'signing_in') return { kind: 'signing_in' };
  if (account.status === 'signed_in') {
    return { kind: 'signed_in', plan: account.planLabel ?? account.plan };
  }
  return { kind: 'signed_out', signIn: account.signIn ?? 'in_app' };
}
