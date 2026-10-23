import {
  Activity,
  Bot,
  ClipboardList,
  FileText,
  FolderTree,
  GitCompare,
  Globe,
  Info,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  ScrollText,
  Smartphone,
  SquareTerminal,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense } from 'react';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { type PlainMessageKey, t } from '@/i18n';
import type { PaneKind } from './pane-kinds';
import type { PaneTab } from './pane-state';
import { BrowserPane } from './panes/browser-pane';
import { FilesPane } from './panes/files-pane';
import { OverviewPane } from './panes/overview-pane';
import { PlaceholderPane } from './panes/placeholder-pane';
import { ProcessesPane } from './panes/processes-pane';
import { RetroPane } from './panes/retro-pane';
import { SessionPane } from './panes/session-pane';
import { SubagentsPane } from './panes/subagents-pane';
import { TasksPane } from './panes/tasks-pane';

/** 窗格内容拿得到的东西：当前路由所在的工作区与会话，以及路由里的子智能体（R5，desktop-layout.md §5.2）。 */
export interface PaneContext {
  entry: WorkspaceEntry | undefined;
  sessionId: string | undefined;
  childId: string | undefined;
}

interface PaneView {
  icon: LucideIcon;
  name: PlainMessageKey;
  /** 标签上的名称；默认是种类名，文件取文件名。 */
  title?: (tab: PaneTab) => string | undefined;
  render: (tab: PaneTab, context: PaneContext) => ReactNode;
}

const placeholder = (kind: PaneKind) => () => <PlaceholderPane name={t(VIEWS[kind].name)} />;

// “变更”窗格带着 @pierre/diffs 与 Shiki，第一次打开时才加载（0.20.0）。
const ChangesPane = lazy(() =>
  import('./panes/changes-pane').then((module) => ({ default: module.ChangesPane })),
);
// “终端”带着 xterm.js（0.69.0），第一次打开时才加载。
const TerminalPane = lazy(() =>
  import('./panes/terminal-pane').then((module) => ({ default: module.TerminalPane })),
);
// “文件预览”同样带着 Pierre 与 Shiki（U32）；文件树不带，直接打进主包。
const FilePane = lazy(() =>
  import('./panes/file-pane').then((module) => ({ default: module.FilePane })),
);
// “模拟器”带着解码与标注（0.122.0），第一次打开时才加载。
const SimulatorPane = lazy(() =>
  import('./panes/simulator-pane').then((module) => ({ default: module.SimulatorPane })),
);

/** 每种窗格的图标、名称与内容（desktop-layout.md §2.1）。以后的种类由各自的任务换掉占位。 */
const VIEWS: Record<PaneKind, PaneView> = {
  overview: {
    icon: Info,
    name: 'pane.kind.overview',
    render: (_, context) => <OverviewPane entry={context.entry} />,
  },
  subagents: {
    icon: Bot,
    name: 'pane.kind.subagents',
    render: (_, context) => <SubagentsPane context={context} />,
  },
  changes: {
    icon: GitCompare,
    name: 'pane.kind.changes',
    render: (_, context) => (
      <Suspense fallback={null}>
        <ChangesPane context={context} />
      </Suspense>
    ),
  },
  files: {
    icon: FolderTree,
    name: 'pane.kind.files',
    render: (_, context) => <FilesPane context={context} />,
  },
  file: {
    icon: FileText,
    name: 'pane.kind.file',
    title: (tab) => tab.params?.path?.split('/').at(-1),
    render: (tab, context) => (
      <Suspense fallback={null}>
        <FilePane tab={tab} context={context} />
      </Suspense>
    ),
  },
  tasks: {
    icon: Activity,
    name: 'pane.kind.tasks',
    render: (_, context) => <TasksPane context={context} />,
  },
  plan: { icon: ListChecks, name: 'pane.kind.plan', render: placeholder('plan') },
  processes: {
    icon: ScrollText,
    name: 'pane.kind.processes',
    render: (_, context) => <ProcessesPane context={context} />,
  },
  // 用户的交互终端（0.69.0）：参数是终端 ID 与标签名（程序设的标题或 shell 名）。
  terminal: {
    icon: SquareTerminal,
    name: 'pane.kind.terminal',
    title: (tab) => tab.params?.label,
    render: (tab, context) => (
      <Suspense fallback={null}>
        <TerminalPane tab={tab} context={context} />
      </Suspense>
    ),
  },
  // 支线会话（U23.1）：参数是支线会话 ID 与问题的开头；agent 请界面显示的会话（0.30.0，`wevir_show`）带它的标题 `label`。
  session: {
    icon: MessagesSquare,
    name: 'pane.kind.session',
    title: (tab) =>
      tab.params?.label ??
      (tab.params?.title ? t('side.tab', { title: tab.params.title }) : undefined),
    render: (tab) => <SessionPane key={tab.params?.sessionId} tab={tab} />,
  },
  browser: {
    icon: Globe,
    name: 'pane.kind.browser',
    render: (_, context) => <BrowserPane context={context} />,
  },
  retro: {
    icon: ClipboardList,
    name: 'pane.kind.retro',
    render: (_, context) => <RetroPane context={context} />,
  },
  simulator: {
    icon: Smartphone,
    name: 'pane.kind.simulator',
    render: (_, context) => (
      <Suspense fallback={null}>
        <SimulatorPane context={context} />
      </Suspense>
    ),
  },
};

export function paneIcon(kind: PaneKind): LucideIcon {
  return VIEWS[kind].icon;
}

export function paneKindName(kind: PaneKind): string {
  return t(VIEWS[kind].name);
}

export function paneTitle(tab: PaneTab): string {
  return VIEWS[tab.kind].title?.(tab) || paneKindName(tab.kind);
}

export function PaneContent({ tab, context }: { tab: PaneTab; context: PaneContext }) {
  return VIEWS[tab.kind].render(tab, context);
}
