import {
  Activity,
  Bot,
  FileText,
  GitCompare,
  Info,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { type PlainMessageKey, t } from '@/i18n';
import type { PaneKind } from './pane-kinds';
import type { PaneTab } from './pane-state';
import { OverviewPane } from './panes/overview-pane';
import { PlaceholderPane } from './panes/placeholder-pane';
import { SubagentsPane } from './panes/subagents-pane';

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
  changes: { icon: GitCompare, name: 'pane.kind.changes', render: placeholder('changes') },
  file: {
    icon: FileText,
    name: 'pane.kind.file',
    title: (tab) => tab.params?.path?.split('/').at(-1),
    render: placeholder('file'),
  },
  tasks: { icon: Activity, name: 'pane.kind.tasks', render: placeholder('tasks') },
  plan: { icon: ListChecks, name: 'pane.kind.plan', render: placeholder('plan') },
  terminal: { icon: SquareTerminal, name: 'pane.kind.terminal', render: placeholder('terminal') },
  session: { icon: MessagesSquare, name: 'pane.kind.session', render: placeholder('session') },
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
