// 会话侧栏的“环境”“上下文”“变更”三张卡片（U18，desktop-layout.md §12；截图 10–12）。“后台任务”在
// panes/subagents-pane.tsx，与“子智能体”窗格同一份数据。

import type { GitFileChange } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, ChevronRight, Folder, GitBranch, Laptop, Layers } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useDiffSupported } from '@/changes/changes-data';
import { openChanges } from '@/changes/changes-store';
import { useTranscript } from '@/data/workbench-data';
import { useEnvironments } from '@/environments/environments';
import { t } from '@/i18n';
import { usePanes } from './pane-controller';
import { abbreviateHome, contextUsage, formatTokens, parentDirectory } from './rail-model';
import { type RailContext, registerRailCard } from './session-rail';

const COPIED_MS = 1500;
/** “变更”展开时先列几个文件。 */
const CHANGED_FILES_SHOWN = 8;

// ── 环境 ────────────────────────────────────────────────────────────

function useEnvironmentCard({ entry, git, session }: RailContext) {
  const { workspace } = entry;
  // 环境会话（U22.1）：环境名、会话自己的目录（可能是 worktree 里的）与额外的文件夹。
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.id === session.environmentId);
  const status = git.status?.repo ? git.status : undefined;
  const branch =
    status?.branch ??
    (status?.detachedAt ? t('rail.environment.detached', { sha: status.detachedAt }) : undefined);
  return {
    summary: <span className="truncate">{branch ?? workspace.displayName}</span>,
    details: (
      <ul className="space-y-0.5">
        <Row icon={<Laptop />}>{t('environment.local')}</Row>
        {environment && (
          <Row icon={<Layers />}>
            <span className="truncate" data-testid="rail-environment-name">
              {environment.name}
            </span>
          </Row>
        )}
        <PathRow name={workspace.displayName} path={session.cwd} />
        {(session.extraRoots ?? []).map((root) => (
          <PathRow key={root} name={basename(root)} path={root} />
        ))}
        {branch && (
          <Row icon={<GitBranch />}>
            <span className="truncate" data-testid="rail-branch">
              {branch}
            </span>
          </Row>
        )}
      </ul>
    ),
  };
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex h-7 min-w-0 items-center gap-2.5">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      {children}
    </li>
  );
}

/** 项目名 · 上一级目录；点一下复制完整路径。 */
function PathRow({ name, path }: { name: string; path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <li>
      <button
        type="button"
        title={copied ? t('environment.copied') : t('environment.copyPath')}
        aria-label={`${t('environment.copyPath')}：${path}`}
        onClick={() => void window.wevir.copyText(path).then(() => setCopied(true))}
        className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden>
          {copied ? <Check className="confirm-pop text-success" /> : <Folder />}
        </span>
        <span className="shrink-0">{name}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          · {abbreviateHome(parentDirectory(path))}
        </span>
      </button>
    </li>
  );
}

registerRailCard({
  id: 'environment',
  order: 10,
  title: () => t('rail.environment'),
  useCard: useEnvironmentCard,
});

// ── 上下文 ──────────────────────────────────────────────────────────

function Meter({ percent, className }: { percent: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      <span
        className="block h-full rounded-full bg-running transition-[width] duration-300 ease-smooth"
        style={{ width: `${Math.max(percent, 2)}%` }}
      />
    </span>
  );
}

function useContextCard({ sessionId, session, providers }: RailContext) {
  const state = useTranscript(sessionId);
  const usage = contextUsage(state?.transcript.usage, session, providers);
  if (!usage) return null;
  const size = formatTokens(usage.size);
  return {
    summary: (
      <>
        <span className="tabular-nums">{usage.percent}%</span>
        <Meter percent={usage.percent} className="w-8" />
      </>
    ),
    details: (
      <div data-testid="rail-context">
        <div className="flex items-baseline justify-between gap-2">
          <span>{t('rail.context.used', { percent: usage.percent })}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatTokens(usage.used)} /{' '}
            {usage.estimated ? t('rail.context.approx', { size }) : size}
          </span>
        </div>
        <Meter percent={usage.percent} className="mt-2 w-full" />
      </div>
    ),
  };
}

registerRailCard({
  id: 'context',
  order: 20,
  title: () => t('rail.context'),
  useCard: useContextCard,
});

// ── 变更 ────────────────────────────────────────────────────────────

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-success">+{added.toLocaleString('en-US')}</span>{' '}
      <span className="text-destructive">−{removed.toLocaleString('en-US')}</span>
    </span>
  );
}

const STATUS_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
};

/** 一个改动的文件；Host 有 `workspace_diff`（0.20.0）时点它在“变更”窗格里打开到这个文件。 */
function FileRow({ file, onOpen }: { file: GitFileChange; onOpen?: (path: string) => void }) {
  const known = file.status in STATUS_LETTERS;
  const content = (
    <>
      <span
        title={
          known
            ? t(`rail.changes.status.${file.status}` as 'rail.changes.status.modified')
            : file.status
        }
        className={cn(
          'w-3 shrink-0 font-mono text-muted-foreground',
          file.status === 'deleted' && 'text-destructive',
          (file.status === 'added' || file.status === 'untracked') && 'text-success',
        )}
      >
        {STATUS_LETTERS[file.status] ?? '?'}
      </span>
      <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono">
        <bdi dir="ltr">{file.path}</bdi>
      </span>
      {file.added !== undefined && file.removed !== undefined && (
        <LineCounts added={file.added} removed={file.removed} />
      )}
    </>
  );
  return (
    <li className="flex h-6 min-w-0 items-center text-xs">
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(file.path)}
          className="-mx-1.5 flex h-6 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {content}
        </button>
      ) : (
        <span className="flex w-full min-w-0 items-center gap-2">{content}</span>
      )}
    </li>
  );
}

function useChangesCard({ git, sessionId }: RailContext) {
  const panes = usePanes();
  const diffSupported = useDiffSupported();
  const status = git.status;
  if (!status?.repo) return null;
  // 0.20.0：打开“变更”窗格（未提交），可带要滚到的文件。
  const open =
    diffSupported && panes
      ? (path?: string) => openChanges(panes, sessionId, { kind: 'uncommitted' }, path)
      : undefined;
  const { added = 0, removed = 0, fileCount = 0, files = [] } = status;
  const shown = files.slice(0, CHANGED_FILES_SHOWN);
  const more = fileCount - shown.length;
  return {
    summary:
      fileCount === 0 ? t('rail.changes.none') : <LineCounts added={added} removed={removed} />,
    details:
      fileCount === 0 ? (
        <p className="text-muted-foreground">{t('rail.changes.none')}</p>
      ) : (
        <div data-testid="rail-changes">
          <div className="flex items-baseline justify-between gap-2">
            <span>{t('rail.changes.files', { count: fileCount })}</span>
            <LineCounts added={added} removed={removed} />
          </div>
          <ul className="mt-1.5">
            {shown.map((file) => (
              <FileRow key={file.path} file={file} {...(open && { onOpen: open })} />
            ))}
          </ul>
          {more > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('rail.changes.more', { count: more })}
            </p>
          )}
          {open && (
            <button
              type="button"
              onClick={() => open()}
              data-testid="rail-changes-open"
              className="-mx-1.5 mt-1.5 flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-soft-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('rail.changes.open')}
              <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      ),
  };
}

registerRailCard({
  id: 'changes',
  order: 30,
  title: () => t('rail.changes'),
  useCard: useChangesCard,
});

function basename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .at(-1) ?? path
  );
}
