// 会话侧栏的“环境”“上下文”“变更”三张卡片（U18，desktop-layout.md §12；截图 10–12）。“后台任务”在
// panes/tasks-pane.tsx，与“后台任务”窗格同一份数据。

import type { WorkspaceGitResult } from '@wevir/protocol';
import { Check, Folder, GitBranch, Laptop, Layers } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useDiffSupported, useMultiFolderChangesSupported } from '@/changes/changes-data';
import { changesPrefs, openChanges } from '@/changes/changes-store';
import { useGitSupported } from '@/changes/git-data';
import { Button } from '@/components/ui/button';
import { useTranscript } from '@/data/workbench-data';
import { useEnvironments } from '@/environments/environments';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { workspaceLabel } from '@/projects/chats';
import { useCompactAction } from '@/session/compact-action';
import { isBusy } from '@/session/composer';
import { ContextBar } from './context-bar';
import { ContextDetails } from './context-breakdown';
import { usePanes } from './pane-controller';
import { abbreviateHome, contextUsage, parentDirectory } from './rail-model';
import { type RailContext, registerRailCard } from './session-rail';

const COPIED_MS = 1500;

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
    summary: <span className="truncate">{branch ?? workspaceLabel(workspace)}</span>,
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
        <PathRow name={workspaceLabel(workspace)} path={session.cwd} />
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
        aria-label={`${t('environment.copyPath')}${t('common.colon')}${path}`}
        onClick={() =>
          void platformApi()
            .copyText(path)
            .then(() => setCopied(true))
        }
        className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
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

function useContextCard({ sessionId, session, providers }: RailContext) {
  const state = useTranscript(sessionId);
  const onCompact = useCompactAction(sessionId);
  const usage = contextUsage(state?.transcript.usage, session, providers);
  if (!usage) return null;
  return {
    summary: (
      <>
        <span className="tabular-nums">{usage.percent}%</span>
        <ContextBar usage={usage} mark={false} className="h-2 w-6" />
      </>
    ),
    details: (
      <ContextDetails
        usage={usage}
        busy={isBusy(session.state)}
        {...(onCompact && { onCompact })}
      />
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

/**
 * 照 Claude Code 的“Changes”：按 git 仓库一行，图标、项目名与 `+N −M`，不列文件。数字是本分支对默认分支的改动（0.163.0 的
 * `branchDiff`，含已提交未推送的提交）；旧 Host 没有时只算未提交的。Host 有 `workspace_diff`（0.20.0）时点这一行在“变更”窗格里
 * 打开同一段（“本分支”或“未提交”），有 `git_commit`（0.67.0）且有未提交的改动时右边多一个“提交”，打开窗格并展开底部的提交区。
 */
function changeCounts(status: WorkspaceGitResult): {
  added: number;
  removed: number;
  fileCount: number;
} {
  const { added = 0, removed = 0, fileCount = 0 } = status.branchDiff ?? status;
  return { added, removed, fileCount };
}

function useChangesCard({ entry, gitFolders, sessionId }: RailContext) {
  const panes = usePanes();
  const diffSupported = useDiffSupported();
  const commitSupported = useGitSupported();
  const multiple = useMultiFolderChangesSupported();
  const repos = gitFolders.flatMap(({ folder, status }) =>
    status?.repo ? [{ folder, status }] : [],
  );
  if (repos.length === 0) return null;
  const totals = repos.reduce(
    (sum, { status }) => {
      const counts = changeCounts(status);
      return {
        added: sum.added + counts.added,
        removed: sum.removed + counts.removed,
        fileCount: sum.fileCount + counts.fileCount,
      };
    },
    { added: 0, removed: 0, fileCount: 0 },
  );
  return {
    summary: totals.fileCount === 0 ? t('rail.changes.none') : <LineCounts {...totals} />,
    details: (
      <div data-testid="rail-changes">
        {repos.map(({ folder, status }) => (
          <ChangesFolderRow
            key={folder}
            folder={folder}
            name={multiple ? basename(folder) : workspaceLabel(entry.workspace)}
            status={status}
            commitSupported={commitSupported}
            open={
              diffSupported && panes
                ? () =>
                    openChanges(
                      panes,
                      sessionId,
                      status.branchDiff ? { kind: 'branch' } : { kind: 'uncommitted' },
                      multiple ? folder : undefined,
                    )
                : undefined
            }
          />
        ))}
      </div>
    ),
  };
}

function ChangesFolderRow({
  folder,
  name,
  status,
  commitSupported,
  open,
}: {
  folder: string;
  name: string;
  status: WorkspaceGitResult;
  commitSupported: boolean;
  open: (() => void) | undefined;
}) {
  const { added, removed, fileCount } = changeCounts(status);
  const counts =
    fileCount === 0 ? (
      <span className="shrink-0 text-muted-foreground">{t('rail.changes.none')}</span>
    ) : (
      <LineCounts added={added} removed={removed} />
    );
  const label = (
    <>
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-soft-foreground">{name}</span>
      {counts}
    </>
  );
  return (
    <div
      data-testid="rail-changes-folder"
      title={folder}
      className="-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-1 rounded-md pr-1"
    >
      {open ? (
        <button
          type="button"
          onClick={open}
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
        >
          {label}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5">{label}</span>
      )}
      {open && commitSupported && (status.fileCount ?? 0) > 0 && (
        <Button
          variant="secondary"
          size="xs"
          data-testid="rail-changes-commit"
          onClick={() => {
            changesPrefs.set((current) => ({ ...current, commit: true }));
            open();
          }}
        >
          {t('commit.title')}
        </Button>
      )}
    </div>
  );
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
