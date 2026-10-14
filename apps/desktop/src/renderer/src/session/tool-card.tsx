import type { ChatPartOf } from '@wevir/client-sdk';
import type { ToolDisplayKind } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Ban,
  Bot,
  Check,
  CircleHelp,
  CircleSlash,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  LoaderCircle,
  type LucideIcon,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { t } from '@/i18n';
import { Disclosure } from './disclosure';
import { between, formatDuration, formatJson } from './format';
import { Thought } from './thought';
import {
  aggregateCounts,
  isInFlight,
  outputSummary,
  type ToolLifecycle,
  type ToolPart,
  toolLifecycle,
  toolSummary,
} from './tool-model';

/** 比这更快的工具调用不显示用时（“0 秒”只是噪音）。 */
const MIN_SHOWN_DURATION_MS = 100;

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

const STATUS_STYLE: Record<ToolLifecycle, { icon: LucideIcon; className: string }> = {
  running: { icon: LoaderCircle, className: 'text-running [&_svg]:animate-spin' },
  awaiting_approval: { icon: ShieldAlert, className: 'text-warning' },
  completed: { icon: Check, className: 'text-success' },
  failed: { icon: X, className: 'text-destructive' },
  denied: { icon: Ban, className: 'text-destructive' },
  cancelled: { icon: CircleSlash, className: 'text-muted-foreground' },
  unknown: { icon: CircleHelp, className: 'text-muted-foreground' },
};

function StatusChip({ lifecycle }: { lifecycle: ToolLifecycle }) {
  const { icon: Icon, className } = STATUS_STYLE[lifecycle];
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-xs', className)}>
      <Icon aria-hidden className="size-3.5" />
      {t(`tool.status.${lifecycle}`)}
    </span>
  );
}

/**
 * 单个工具调用：默认折叠，标题行是工具名、参数摘要、状态与用时；完成后在下方显示结果的第一行。展开看完整
 * 参数（编辑类显示新旧文本、写文件显示内容）与完整结果。
 */
export const ToolCard = memo(function ToolCard({
  part,
  turnActive,
  compact = false,
}: {
  part: ToolPart;
  turnActive: boolean;
  /** 聚合卡片里的一行：不要边框。 */
  compact?: boolean;
}) {
  const lifecycle = toolLifecycle(part, turnActive);
  const Icon = KIND_ICONS[part.display.kind];
  const summary = toolSummary(part);
  const result = isInFlight(lifecycle) ? undefined : outputSummary(part);
  const duration = between(part.startedAt, part.finishedAt);
  return (
    <div
      data-tool-status={lifecycle}
      className={cn(
        'text-sm',
        compact ? 'py-0.5' : 'my-2 rounded-xl border border-border bg-card px-2.5 py-1.5',
      )}
    >
      <Disclosure
        summaryClassName="gap-2 py-0.5"
        summary={
          <>
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{part.toolName}</span>
            {summary && (
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {summary}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {duration !== undefined && duration >= MIN_SHOWN_DURATION_MS && (
                <span className="text-xs text-muted-foreground">{formatDuration(duration)}</span>
              )}
              <StatusChip lifecycle={lifecycle} />
            </span>
          </>
        }
      >
        <ToolDetails part={part} />
      </Disclosure>
      {result && <p className="ml-5.5 truncate text-xs text-muted-foreground">{result}</p>}
    </div>
  );
});

function ToolDetails({ part }: { part: ToolPart }) {
  return (
    <div className="mt-1.5 mb-1 ml-5.5 space-y-2">
      <Section label={t('tool.input')}>
        <ToolInput part={part} />
      </Section>
      <Section label={t('tool.output')}>
        {part.output ? (
          <>
            <Pre>{part.output.text || t('tool.noOutput')}</Pre>
            {part.output.truncated && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('tool.outputTruncated', {
                  length: part.output.originalLength ?? part.output.text.length,
                })}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('tool.noOutput')}</p>
        )}
      </Section>
    </div>
  );
}

function ToolInput({ part }: { part: ToolPart }) {
  const input = isRecord(part.input) ? part.input : undefined;
  if (part.display.kind === 'edit' && input) {
    const before = input.old_string;
    const after = input.new_string;
    if (typeof before === 'string' && typeof after === 'string') {
      return (
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 py-1.5 font-mono text-xs">
          {before.split('\n').map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态的行列表。
            <DiffLine key={`-${index}`} sign="-" line={line} />
          ))}
          {after.split('\n').map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态的行列表。
            <DiffLine key={`+${index}`} sign="+" line={line} />
          ))}
        </pre>
      );
    }
  }
  if (part.display.kind === 'write' && input && typeof input.content === 'string') {
    const { content, ...rest } = input;
    return (
      <>
        <Pre>{formatJson(rest).text}</Pre>
        <Pre className="mt-1.5">{content}</Pre>
      </>
    );
  }
  const { text, truncatedFrom } = formatJson(part.input ?? {});
  return (
    <>
      <Pre>{text}</Pre>
      {truncatedFrom !== undefined && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('tool.inputTruncated', { length: truncatedFrom })}
        </p>
      )}
    </>
  );
}

function DiffLine({ sign, line }: { sign: '-' | '+'; line: string }) {
  return (
    <span
      className={cn(
        'block px-2 whitespace-pre-wrap',
        sign === '-' ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success',
      )}
    >
      {sign} {line}
    </span>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-words',
        className,
      )}
    >
      {children}
    </pre>
  );
}

/**
 * 连续的读取 / 搜索聚合成一张卡片（OpenWork 候选 #6 的做法）：标题是“读取 3 个文件、搜索 2 次”，进行中
 * 加“正在”；展开后逐个列出，原本夹在中间的思考按顺序保留。
 */
export const AggregateToolCard = memo(function AggregateToolCard({
  tools,
  entries,
  turnActive,
}: {
  tools: readonly ToolPart[];
  entries: ReadonlyArray<ToolPart | ChatPartOf<'reasoning'>>;
  turnActive: boolean;
}) {
  const lifecycles = tools.map((tool) => toolLifecycle(tool, turnActive));
  const lifecycle: ToolLifecycle = lifecycles.some(isInFlight)
    ? 'running'
    : lifecycles.includes('failed')
      ? 'failed'
      : lifecycles.includes('unknown')
        ? 'unknown'
        : 'completed';
  const { files, searches } = aggregateCounts(tools);
  const pieces = [
    files > 0 ? t('tool.aggregate.read', { count: files }) : undefined,
    searches > 0 ? t('tool.aggregate.search', { count: searches }) : undefined,
  ].filter(Boolean);
  const summary = pieces.join(t('tool.aggregate.separator'));
  return (
    <div
      data-tool-status={lifecycle}
      className="my-2 rounded-xl border border-border bg-card px-2.5 py-1.5 text-sm"
    >
      <Disclosure
        summaryClassName="gap-2 py-0.5"
        summary={
          <>
            <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {lifecycle === 'running' ? t('tool.aggregate.running', { summary }) : summary}
            </span>
            <StatusChip lifecycle={lifecycle} />
          </>
        }
      >
        <div className="mt-1 ml-5.5 divide-y divide-border/60">
          {entries.map((entry) =>
            entry.type === 'tool' ? (
              <ToolCard key={entry.key} part={entry} turnActive={turnActive} compact />
            ) : (
              <Thought key={entry.key} part={entry} settled />
            ),
          )}
        </div>
      </Disclosure>
    </div>
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
