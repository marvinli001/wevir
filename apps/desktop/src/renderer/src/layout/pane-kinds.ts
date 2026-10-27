// 窗格种类（R12，docs/architecture/desktop-layout.md §2.1）。纯数据：最小尺寸、形状、能否多开、是否已经实现；
// 图标、名称与内容在 pane-registry.tsx。

export const PANE_KINDS = [
  'overview',
  'subagents',
  'changes',
  'files',
  'file',
  'tasks',
  'plan',
  'processes',
  'terminal',
  'session',
  'browser',
  'retro',
  'simulator',
] as const;

export type PaneKind = (typeof PANE_KINDS)[number];

/** 标签的参数，例如文件的相对路径。只放 ID 与路径这类短字符串，不放内容。 */
export type PaneParams = Readonly<Record<string, string>>;

export interface PaneKindSpec {
  /** 整个窗格（含 36 px 的窗格头）的最小宽与高。 */
  minWidth: number;
  minHeight: number;
  /** “高”的窗格优先占整列；上下叠放时“矮”的分得少一些（§4.3）。 */
  shape: 'tall' | 'compact';
  /** 能否多开。能多开的按 `identityParam` 判断是不是同一个；没有这个参数时每次都新开。 */
  multiple: boolean;
  identityParam?: string;
  /** false：以后的任务才实现，只在开发模式里能打开占位，用来检查排布。 */
  available: boolean;
  /** 只由功能打开（要参数，例如 U23.1 的支线窗格），不进“打开窗格”菜单。 */
  internal?: boolean;
}

export const PANE_KIND_SPECS: Readonly<Record<PaneKind, PaneKindSpec>> = {
  // U18 起并进会话侧栏的“环境”卡片（desktop-layout.md §12）：种类留着读回旧的本机状态，不再出现在“打开窗格”里。
  overview: { minWidth: 280, minHeight: 160, shape: 'compact', multiple: false, available: false },
  // 列表与详情并进了“后台任务”（tasks）：种类留着读回旧的本机状态，不再出现在“打开窗格”里。
  subagents: {
    minWidth: 300,
    minHeight: 200,
    shape: 'tall',
    multiple: false,
    available: false,
    internal: true,
  },
  // 0.20.0：当前会话目录的 diff（desktop-layout.md §18）。
  changes: { minWidth: 360, minHeight: 240, shape: 'tall', multiple: false, available: true },
  // 0.22.0（U32）：会话目录的文件树，点开的文件在“文件预览”里（按路径多开）。
  files: { minWidth: 260, minHeight: 200, shape: 'tall', multiple: false, available: true },
  file: {
    minWidth: 360,
    minHeight: 240,
    shape: 'tall',
    multiple: true,
    identityParam: 'path',
    available: true,
    internal: true,
  },
  tasks: { minWidth: 300, minHeight: 200, shape: 'tall', multiple: false, available: true },
  plan: { minWidth: 280, minHeight: 160, shape: 'compact', multiple: false, available: false },
  // 0.69.0：Host 起的后台进程（Agent 的与检查的）的输出与停止，不是终端。
  // 2026-10-27 并进了“后台任务”（tasks）：种类留着读回旧的本机状态，不再出现在“打开窗格”里。
  processes: {
    minWidth: 320,
    minHeight: 200,
    shape: 'tall',
    multiple: false,
    available: false,
    internal: true,
  },
  // 0.69.0：用户的交互终端（ADR-0010），Host 上的 PTY；按终端 ID 多开，“打开窗格”每次开一个新的。
  terminal: {
    minWidth: 360,
    minHeight: 160,
    shape: 'compact',
    multiple: true,
    identityParam: 'id',
    available: true,
  },
  session: {
    minWidth: 400,
    minHeight: 280,
    shape: 'tall',
    multiple: true,
    identityParam: 'sessionId',
    available: true,
    internal: true,
  },
  // 0.33.0：内置浏览器（desktop-layout.md §21），当前会话的标签页；网页是主进程的原生视图。
  browser: { minWidth: 360, minHeight: 240, shape: 'tall', multiple: false, available: true },
  // 0.76.0：当前会话的任务回顾，由侧栏的“任务回顾”卡片打开。
  retro: { minWidth: 320, minHeight: 240, shape: 'tall', multiple: false, available: true },
  // 0.122.0：iOS 模拟器（desktop-layout.md §44），Host 声明 `ios_simulator` 时才能开。
  simulator: { minWidth: 360, minHeight: 360, shape: 'tall', multiple: false, available: true },
};

export function isPaneKind(value: unknown): value is PaneKind {
  return (PANE_KINDS as readonly unknown[]).includes(value);
}

/**
 * 判断两个标签是不是“同一个”：单开的种类按种类；能多开的按 identityParam 的值，没有这个值就是独一份（返回
 * undefined，打开时总是新开）。
 */
export function paneIdentity(kind: PaneKind, params: PaneParams | undefined): string | undefined {
  const spec = PANE_KIND_SPECS[kind];
  if (!spec.multiple) return kind;
  const value = spec.identityParam === undefined ? undefined : params?.[spec.identityParam];
  return value === undefined ? undefined : `${kind}:${value}`;
}

/**
 * 外壳与这条连接能用哪些窗格：浏览器窗格要外壳有内置浏览器；用户终端要 `terminal.write`；模拟器要 Host 声明 `ios_simulator`。
 * 默认都能用。
 */
export interface PaneAccess {
  browserPane: boolean;
  terminalWrite: boolean;
  simulator: boolean;
}

export const FULL_PANE_ACCESS: PaneAccess = {
  browserPane: true,
  terminalWrite: true,
  simulator: true,
};

export function paneKindUsable(kind: PaneKind, access: PaneAccess): boolean {
  if (kind === 'browser') return access.browserPane;
  if (kind === 'terminal') return access.terminalWrite;
  if (kind === 'simulator') return access.simulator;
  return true;
}

/**
 * “打开窗格”菜单里能打开的种类：正式构建只有已经实现的，开发模式下还有以后的种类的占位；只由功能打开的（支线）不在里面，外壳或
 * 连接用不了的也不在。
 */
export function openableKinds(dev: boolean, access: PaneAccess = FULL_PANE_ACCESS): PaneKind[] {
  return PANE_KINDS.filter(
    (kind) =>
      !PANE_KIND_SPECS[kind].internal &&
      (dev || PANE_KIND_SPECS[kind].available) &&
      paneKindUsable(kind, access),
  );
}
