// 审批卡片的文案与内容（T5.3），按 acp-event-mapping.md §5.5。标题按展示类型与会话的边界（`ApprovalScope`）：Codex 与 dsh
// 只为越过沙箱的操作请求批准，Claude Agent 这类订阅引擎在项目目录里改文件、运行命令也问（claude-event-mapping.md §5.1），
// 所以“项目目录之外”“沙箱之外”只在请求确实如此时写。正文是目标、所需权限、Agent 给出的理由，写文件再附内容预览；按钮按
// 请求携带的选项。U13 起照 Claude Code 的权限提示：标题是一句问话，目标（命令全文或路径）放在代码块里，选项分左右两组、
// 带数字键。纯函数，组件在 approval-card.tsx。

import {
  type ApprovalDetail,
  type ApprovalOption,
  type ApprovalRequest,
  type ApprovalResolution,
  type ClientIdentity,
  type ProviderProfile,
  type Session,
  SUBSCRIPTION_KINDS,
} from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';

/** 内容预览最多显示的行数。 */
const PREVIEW_LINES = 6;

export interface ApprovalPresentation {
  title: string;
  /** 目标：命令全文或路径。 */
  target?: string;
  permission?: string;
  justification?: string;
  /** 写文件时的内容开头。 */
  preview?: { text: string; more: boolean };
}

/**
 * 审批所在会话的边界（`approvalScope`）。会话还没读到、Provider 不认识时没有，标题按“不知道会话的边界”写，不说“之外”。
 */
export interface ApprovalScope {
  /** 会话的目录：主文件夹、额外的文件夹与 worktree。 */
  roots: readonly string[];
  /**
   * 引擎只为越过沙箱的操作请求批准：Codex 与 dsh（ChatGPT、DeepSeek 官方、OpenAI 兼容的 Provider）。订阅来源的引擎
   * （Claude Agent 等）按自己的规则问。
   */
  sandboxed: boolean;
}

type ScopeSession = Pick<Session, 'cwd' | 'extraRoots' | 'worktrees' | 'providerId'>;

export function approvalScope(
  session: ScopeSession,
  providers: readonly Pick<ProviderProfile, 'id' | 'kind'>[],
): ApprovalScope | undefined {
  const provider = providers.find((candidate) => candidate.id === session.providerId);
  if (!provider) return undefined;
  return {
    roots: [
      session.cwd,
      ...(session.extraRoots ?? []),
      ...(session.worktrees ?? []).map((worktree) => worktree.path),
    ],
    sandboxed: !(SUBSCRIPTION_KINDS as readonly string[]).includes(provider.kind),
  };
}

export function presentApproval(
  approval: ApprovalRequest,
  scope?: ApprovalScope,
): ApprovalPresentation {
  const detail = approval.detail;
  if (!detail) {
    return { title: t(scope?.sandboxed ? 'approval.title.outside' : 'approval.title.generic') };
  }
  const kind = detail.display.kind;
  const title = t(titleKey(detail, scope));
  const target = (
    kind === 'shell'
      ? (detail.display.command ?? detail.display.summary)
      : (detail.display.paths?.join('\n') ?? detail.display.summary ?? detail.display.command)
  )?.trim();
  const presentation: ApprovalPresentation = { title };
  if (target) presentation.target = target;
  if (detail.sandboxPermissions) {
    presentation.permission =
      detail.sandboxPermissions === 'danger-full-access'
        ? t('approval.permission.fullAccess')
        : detail.sandboxPermissions;
  }
  if (detail.justification) presentation.justification = detail.justification;
  const content = isRecord(detail.input) ? detail.input.content : undefined;
  if (kind === 'write' && typeof content === 'string') {
    const lines = content.split('\n');
    presentation.preview = {
      text: lines.slice(0, PREVIEW_LINES).join('\n'),
      more: lines.length > PREVIEW_LINES,
    };
  }
  return presentation;
}

/**
 * 审批只给两个按钮（照 Claude Code 与 Codex，维护者 2026-10-15 定）：左边“拒绝”（1、Esc），右边“允许”（2、⌘↵，主按钮）。
 * 拒绝取 Codex 的“拒绝并停止”（`reject_cancel`：停下回合等用户说怎么做，同两者的 No / Deny），没有时取第一个拒绝类；允许取
 * 第一个允许类（只允许这一次）。“本会话不再询问”这类选项不再出现，长期放开改用权限模式（自动批准、完全访问，0.11.0）。
 */
export interface ApprovalLayout {
  reject: ApprovalOption | undefined;
  allow: ApprovalOption | undefined;
  /** 从左到右，第 i 个对应数字键 i + 1。 */
  numbered: ApprovalOption[];
}

export function approvalLayout(options: readonly ApprovalOption[]): ApprovalLayout {
  const rejects = options.filter((option) => option.category === 'reject');
  const reject = rejects.find((option) => option.kind === 'reject_cancel') ?? rejects[0];
  const allow = options.find((option) => option.category === 'allow');
  return {
    reject,
    allow,
    numbered: [reject, allow].filter((option) => option !== undefined),
  };
}

/**
 * “总是允许”（0.80.0）：审批带 Host 提议的规则时，允许类选项旁边多一个按钮，按 `remember` 加规则后允许这一次（数字键 3）。
 * 用的是“允许”那个选项。
 */
export function alwaysAllow(
  approval: Pick<ApprovalRequest, 'proposedRule' | 'options'>,
): { option: ApprovalOption; prefix: string } | undefined {
  const option = approval.options.find((candidate) => candidate.category === 'allow');
  const prefixes = approval.proposedRule?.prefixes;
  if (option === undefined || prefixes === undefined) return undefined;
  return { option, prefix: prefixes.map(prefixText).join(t('common.listSeparator')) };
}

/** 显示用的前缀：`git status`，含空白或引号的词加单引号（与 Host 的 `formatPrefix` 一致）。 */
export function prefixText(prefix: readonly string[]): string {
  return prefix
    .map((token) =>
      /^[A-Za-z0-9._:@%+=,/-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}

/** 选项按钮的文字：认识的 kind 本地化，不认识的显示引擎给的 label（与 CLI 的 optionLabel 一致）。 */
export function optionLabel(option: Pick<ApprovalOption, 'kind' | 'label'>): string {
  const key = OPTION_LABELS[option.kind];
  return key ? t(key) : option.label || option.kind;
}

const OPTION_LABELS: Record<string, PlainMessageKey> = {
  allow_once: 'approval.option.allowOnce',
  allow_always: 'approval.option.allowAlways',
  reject_once: 'approval.option.reject',
  reject_always: 'approval.option.rejectAlways',
  // Codex 与 Claude 适配器的选项（它们的 label 是简体中文）。
  allow_accept: 'approval.allow',
  allow_accept_for_session: 'approval.option.allowForSession',
  reject_decline: 'approval.reject',
  reject_cancel: 'approval.option.rejectAndStop',
};

const CLIENT_KIND_LABELS: Record<ClientIdentity['clientKind'], PlainMessageKey> = {
  desktop: 'client.desktop',
  cli: 'client.cli',
  mobile: 'client.mobile',
};

/** “本机的 CLI”“桌面端（设备 dev-6f1c）”这样的称呼；`self` 是本连接的身份。 */
export function clientLabel(client: ClientIdentity, self: ClientIdentity | undefined): string {
  const kind = t(CLIENT_KIND_LABELS[client.clientKind]);
  if (self && client.deviceId === self.deviceId) {
    return client.clientId === self.clientId
      ? t('client.thisWindow')
      : t('client.sameDevice', { kind });
  }
  return t('client.otherDevice', { kind, device: client.deviceId.slice(0, 10) });
}

/** 审批结算后的一句话，例如“已由本机的 CLI 处理：允许一次”“审批已取消（回合被取消）”。 */
export function resolutionText(
  approval: ApprovalRequest,
  resolution: ApprovalResolution,
  self: ClientIdentity | undefined,
): string {
  if (resolution.reason === 'rule') return t('approval.byRule');
  if (resolution.reason !== 'user') return t(`approval.ended.${resolution.reason}`);
  const option = approval.options.find((candidate) => candidate.optionId === resolution.optionId);
  const decision = option ? optionLabel(option) : (resolution.optionId ?? '');
  if (!resolution.decidedBy) return t('approval.resolved', { decision });
  return t('approval.resolvedBy', { who: clientLabel(resolution.decidedBy, self), decision });
}

/** 这次结算是不是本窗口做的（本窗口的决定不另外提示）。 */
export function decidedHere(
  resolution: ApprovalResolution | undefined,
  self: ClientIdentity | undefined,
): boolean {
  return (
    resolution?.reason === 'user' &&
    self !== undefined &&
    resolution.decidedBy?.clientId === self.clientId &&
    resolution.decidedBy.deviceId === self.deviceId
  );
}

/** Wevir 自己的应用级工具（0.30.0，浏览器工具 0.33.0）里要批准的：按工具说清楚做什么。 */
const APP_TOOL_TITLES: Readonly<Record<string, PlainMessageKey>> = {
  wevir_session_create: 'approval.title.appCreate',
  wevir_session_send: 'approval.title.appSend',
  wevir_session_interrupt: 'approval.title.appInterrupt',
  wevir_session_close: 'approval.title.appClose',
  wevir_session_archive: 'approval.title.appArchive',
  wevir_plugin_install: 'approval.title.pluginInstall',
  wevir_skill_install: 'approval.title.skillInstall',
  wevir_connector_add: 'approval.title.connectorAdd',
  // 内置浏览器（0.33.0）：只读的不问，其余按会话的权限模式问。
  browser_new_tab: 'approval.title.browserOpen',
  browser_navigate: 'approval.title.browserOpen',
  browser_close_tab: 'approval.title.browserClose',
  browser_claim_tab: 'approval.title.browserClaim',
  browser_click: 'approval.title.browserAct',
  browser_fill: 'approval.title.browserAct',
  browser_type: 'approval.title.browserAct',
  browser_keypress: 'approval.title.browserAct',
  browser_select: 'approval.title.browserAct',
  browser_hover: 'approval.title.browserAct',
  browser_drag: 'approval.title.browserAct',
  browser_scroll: 'approval.title.browserAct',
  browser_back: 'approval.title.browserAct',
  browser_forward: 'approval.title.browserAct',
  browser_reload: 'approval.title.browserAct',
  // 一次做多步：卡片里列出每一步、写出脚本全文（Host 换好了 display.summary）。
  browser_batch: 'approval.title.browserBatch',
  browser_run: 'approval.title.browserRun',
};

/**
 * 标题：改文件看路径在不在会话的目录里，路径不全时按引擎（沙箱引擎只为目录之外的文件问）；读文件、搜索只在路径出了目录时
 * 单说；命令按引擎，请求带着 `sandboxPermissions` 的也是越过沙箱。
 */
function titleKey(detail: ApprovalDetail, scope: ApprovalScope | undefined): PlainMessageKey {
  // Codex 把按需加载的应用级工具挂在 `wevir_more` 上。
  const appToolName = /^mcp__wevir(?:_more)?__(.+)$/.exec(detail.toolName)?.[1];
  const appTool = appToolName === undefined ? undefined : APP_TOOL_TITLES[appToolName];
  if (appTool !== undefined) return appTool;
  const { kind, paths } = detail.display;
  const outside =
    scope && paths?.length ? paths.some((path) => !within(path, scope.roots)) : undefined;
  switch (kind) {
    case 'write':
    case 'edit':
      return (outside ?? scope?.sandboxed) ? 'approval.title.fileOutside' : 'approval.title.file';
    case 'read':
    case 'search':
      if (outside) return 'approval.title.readOutside';
      break;
    case 'shell':
      return scope?.sandboxed || detail.sandboxPermissions
        ? 'approval.title.shellOutside'
        : 'approval.title.shell';
  }
  return scope?.sandboxed ? 'approval.title.outside' : 'approval.title.generic';
}

/** `path` 是不是在某个目录里（含目录本身）；相对路径按第一个目录（会话的工作目录）算。 */
function within(path: string, roots: readonly string[]): boolean {
  const [cwd] = roots;
  if (cwd === undefined) return false;
  const target = normalizePath(isAbsolute(path) ? path : `${cwd}/${path}`);
  return roots.some((root) => {
    const base = normalizePath(root);
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`);
  });
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/** 分隔符统一成 `/`，去掉 `.` 与 `..`；Windows 的盘符路径不分大小写。 */
function normalizePath(path: string): string {
  const drive = /^[A-Za-z]:/.test(path);
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const joined = drive ? parts.join('/') : `/${parts.join('/')}`;
  return drive ? joined.toLowerCase() : joined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
