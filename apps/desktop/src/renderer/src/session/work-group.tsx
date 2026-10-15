import type { ToolDisplayKind } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Bot,
  Bug,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { createContext, Fragment, useContext, useId } from 'react';
import { Collapse } from '@/components/collapse';
import { t } from '@/i18n';
import { Elapsed } from './elapsed';
import { useFold } from './fold-state';
import { formatJson } from './format';
import { AWAITING_PILL, LiveIndicator, type LiveState } from './live-indicator';
import { ToolDetails } from './tool-details';
import {
  currentAction,
  editStats,
  type IssueKind,
  isLiveEntry,
  type LineStats,
  outputSummary,
  rawLine,
  tallyWork,
  thoughtLine,
  toolLine,
  type WorkEntry,
  type WorkLineView,
  workIssues,
  workSummaryParts,
} from './tool-model';

const KIND_ICONS: Record<ToolDisplayKind, LucideIcon> = {
  shell: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePen,
  search: Search,
  fetch: Globe,
  plan: ListTodo,
  sub_agent: Bot,
  unknown: Wrench,
};

const LINE_TONES: Record<WorkLineView['tone'], string> = {
  done: '',
  running: 'shimmer',
  awaiting: 'text-warning',
  failed: 'text-destructive',
  muted: '',
  unknown: 'text-warning',
};

const ISSUE_TONES: Record<IssueKind, string> = {
  failed: 'text-destructive',
  denied: 'text-destructive',
  unknown: 'text-warning',
};

/** 会话的工作目录：逐条里的路径相对它显示（transcript-view.tsx 提供）。 */
export const WorkspaceRoot = createContext<string | undefined>(undefined);

/** 增删行数的小标签：“+12 −3”。 */
export function DiffStat({ stats }: { stats: LineStats }) {
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-sm font-mono text-xs leading-[18px] tabular-nums">
      <span className="bg-success/10 px-1.5 text-success">+{stats.added}</span>
      <span className="bg-destructive/10 px-1.5 text-destructive">−{stats.removed}</span>
    </span>
  );
}

/** 摘要后面的“· 1 个失败 · 1 个被拒绝”：失败与被拒绝用失败色，状态未知用警示色。 */
export function IssueFlags({ issues }: { issues: Readonly<Record<IssueKind, number>> }) {
  return workIssues(issues).map((issue) => (
    <span key={issue.kind} data-work-issue={issue.kind} className="flex shrink-0 gap-1.5">
      <span aria-hidden>·</span>
      <span className={ISSUE_TONES[issue.kind]}>{issue.text}</span>
    </span>
  ));
}

/**
 * 一串连续的思考与工具调用（U2，照 Claude Code 桌面端与 Codex，design-refs/09、12）：收起时一行摘要（“思考了 17 秒，
 * 读取了 6 个文件，修改了 index.ts，运行了 2 条命令”加改动行数，只涉及一个文件时写出文件名，失败、被拒绝、状态未知另外
 * 标出）；展开是逐条的一行，有详情的那条可以再单独展开。进行中的回合里，排在最后的那一组显示当前动作（闪光文字、已用
 * 时间，前面是状态图标位）。U16 起进行中的那一组默认展开，下面列出已经做完的步骤（照 Codex 的进行中列表），正在做的那条
 * 由组头代表；这一组做完（后面有了正文或回合结束）就收回成摘要，用户点过的照用户的。
 */
export function WorkGroup({
  foldKey,
  entries,
  turnActive,
  tail,
  live,
  startedAt,
}: {
  /** 展开状态的 key（fold-state.tsx）。 */
  foldKey: string;
  entries: readonly WorkEntry[];
  turnActive: boolean;
  /** 是消息里的最后一项：最后一条思考可能还在流出。 */
  tail: boolean;
  /** 进行中的回合里正在执行的这一组：显示当前动作。 */
  live?: LiveState;
  /** 回合开始的时刻（当前动作后面的已用时间）。 */
  startedAt?: string;
}) {
  const [open, setOpen] = useFold(foldKey, live !== undefined);
  const id = useId();
  const tally = tallyWork(entries, turnActive);
  const root = useContext(WorkspaceRoot);
  const action = live ? currentAction(entries, root) : undefined;
  const indicator: LiveState | undefined =
    live === 'stopping' ? 'stopping' : action?.tone === 'awaiting' ? 'awaiting' : live;
  const shown = live
    ? entries.filter((entry, index) => !isLiveEntry(entry, index === entries.length - 1, tail))
    : entries;
  return (
    <div className="my-1.5" data-work-group={live ? 'live' : 'done'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex max-w-full min-h-6 items-center gap-2 rounded-lg text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          open && 'text-foreground',
        )}
      >
        {action && indicator ? (
          <>
            <LiveIndicator state={indicator} />
            <span
              className={cn(
                'min-w-0 truncate',
                action.tone === 'awaiting' ? AWAITING_PILL : 'shimmer',
              )}
            >
              {live === 'stopping' ? t('work.stopping') : action.text}
            </span>
            <Elapsed since={startedAt} className="shrink-0 tabular-nums" />
          </>
        ) : (
          <>
            <SummaryText tally={tally} />
            {tally.lines && <DiffStat stats={tally.lines} />}
            <IssueFlags issues={tally.issues} />
          </>
        )}
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 shrink-0 opacity-75 transition-transform', open && 'rotate-90')}
        />
      </button>
      <Collapse open={open} id={id}>
        <ul className="mt-0.5 flex flex-col">
          {shown.map((entry) => (
            <WorkLine
              key={entry.key}
              entry={entry}
              turnActive={turnActive}
              settled={entry !== entries.at(-1) || !tail}
            />
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/** 摘要：说明文字色，只涉及一个文件时文件名用正文色（照 Claude Code 的“created style-nonce.ts”）。 */
function SummaryText({ tally }: { tally: ReturnType<typeof tallyWork> }) {
  return (
    <span className="min-w-0 truncate">
      {workSummaryParts(tally).map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 摘要的几段只按位置区分，内容变了整行重画。
        <Fragment key={index}>
          {index > 0 && t('work.separator')}
          {part.text}
          {part.file && (
            <>
              {part.text && ' '}
              <span className="text-foreground" data-summary-file>
                {part.file}
              </span>
              {part.after && ` ${part.after}`}
            </>
          )}
        </Fragment>
      ))}
    </span>
  );
}

/** 展开后的一行：图标、“已读取 / 已运行 / 运行失败…”、等宽的目标；有详情时可以再单独展开。 */
function WorkLine({
  entry,
  turnActive,
  settled,
}: {
  entry: WorkEntry;
  turnActive: boolean;
  settled: boolean;
}) {
  const [open, setOpen] = useFold(`line:${entry.key}`, false);
  const id = useId();
  const root = useContext(WorkspaceRoot);
  const view =
    entry.type === 'reasoning'
      ? thoughtLine(entry, settled)
      : entry.type === 'raw'
        ? rawLine(entry)
        : toolLine(entry, turnActive, root);
  const Icon =
    entry.type === 'reasoning'
      ? Lightbulb
      : entry.type === 'raw'
        ? Bug
        : KIND_ICONS[entry.display.kind];
  const stats = entry.type === 'tool' && view.tone === 'done' ? editStats(entry) : undefined;
  const hasDetail = entry.type !== 'reasoning' || entry.text.trim() !== '';
  // 失败与被拒绝的那条醒目标出：标签用失败色，下面带结果的第一行。
  const problem =
    entry.type === 'tool' && view.tone === 'failed' ? outputSummary(entry) : undefined;
  return (
    <li data-work-line={view.tone}>
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? id : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded-lg text-left text-sm text-muted-foreground outline-none enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 opacity-85" />
        <span className={cn('shrink-0', LINE_TONES[view.tone])}>{view.label}</span>
        {view.target && (
          <code className="min-w-0 truncate font-mono text-xs text-soft-foreground">
            {view.target}
          </code>
        )}
        {stats && <DiffStat stats={stats} />}
        {hasDetail && (
          <ChevronRight
            aria-hidden
            className={cn('size-3 shrink-0 opacity-70 transition-transform', open && 'rotate-90')}
          />
        )}
      </button>
      {problem && !open && (
        <p className="ml-5.5 truncate font-mono text-xs text-destructive">{problem}</p>
      )}
      <Collapse open={open && hasDetail} id={id}>
        <div className="mt-1 mb-2 ml-5.5">
          {entry.type === 'reasoning' ? (
            <p className="border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
              {entry.text}
            </p>
          ) : entry.type === 'raw' ? (
            <pre className="max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {formatJson(entry.params).text}
            </pre>
          ) : (
            <ToolDetails part={entry} root={root} />
          )}
        </div>
      </Collapse>
    </li>
  );
}
