// “变更”窗格底部的提交卡片（0.67.0，ADR-0009；外形照 Codex 的输入框）：顶上一行是分支与“已暂存 N/M”（点开是逐个文件
// 暂存、取消暂存的列表），下面是提交说明、验证记录的小标签与“提交”。不是在这里暂存的内容（之前就暂存的、目录外的）在说明
// 上面单独一条警示，勾“一并提交”才能提交；验证记录只显示、不挡提交；提交失败时显示原因与 git 的输出，什么都不回滚。
// diff 文件头的勾选框是同一套暂存操作（changes-pane.tsx）。

import type { GitCommitOutcome, GitStatusFile, GitVerificationCheck } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { ScrollFade } from '@/components/scroll-fade';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import { IS_MAC } from '@/lib/shortcuts';
import { splitPath } from './changes-model';
import {
  type CheckTone,
  canCommit,
  changedCount,
  checkLabel,
  checkTone,
  failureLabel,
  groupFiles,
  operationLabel,
  statusLetter,
} from './commit-model';
import type { GitState } from './git-data';

const SUBMIT_SHORTCUT = IS_MAC ? '⌘↩' : 'Ctrl+↩';

const TONE: Record<CheckTone, { icon: typeof Circle; className: string }> = {
  passed: { icon: CircleCheck, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-destructive' },
  stale: { icon: Clock, className: 'text-warning' },
  running: { icon: LoaderCircle, className: 'animate-spin text-muted-foreground' },
  not_run: { icon: Circle, className: 'text-muted-foreground' },
};

export function CommitPanel({
  git,
  open,
  onOpenChange,
  onReveal,
}: {
  git: GitState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReveal: (path: string, staged: boolean) => void;
}) {
  const { status } = git;
  const groups = groupFiles(status);
  const [message, setMessage] = useState('');
  const [includeExternal, setIncludeExternal] = useState(false);
  const [outcome, setOutcome] = useState<GitCommitOutcome>();
  if (status?.repo !== true) return null;

  const include = includeExternal && groups.external.length > 0;
  const ready = canCommit(status, groups, message, include) && !git.busy;
  const submit = () => {
    if (!ready) return;
    setOutcome(undefined);
    void git.commit(message, include).then((result) => {
      setOutcome(result);
      if (result?.kind === 'committed') {
        setMessage('');
        setIncludeExternal(false);
      }
    });
  };
  const total = changedCount(groups);
  const stagedCount = groups.staged.length + groups.external.filter((file) => file.outside).length;
  const clean = total === 0 && groups.external.length === 0;
  const expanded = open && !clean;
  const checks = status.verification?.checks ?? [];
  const hasStatus = git.error !== undefined || outcome?.kind === 'committed';

  return (
    <section className="shrink-0 px-2 pb-2" data-commit-panel>
      <div className="flex max-h-[min(28rem,60vh)] flex-col rounded-2xl border border-border bg-card shadow-xs">
        <div className="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3 text-xs">
          <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-muted-foreground" data-commit-branch>
            {status.branch ?? status.head?.slice(0, 7) ?? ''}
          </span>
          {clean ? (
            <span className="ml-1.5 shrink-0 text-muted-foreground">{t('commit.clean')}</span>
          ) : (
            <FilesPopover git={git} total={total} stagedCount={stagedCount} onReveal={onReveal} />
          )}
          <span className="min-w-1 flex-1" />
          {clean && outcome?.kind === 'committed' && <Committed outcome={outcome} />}
          {!clean && groups.unstaged.some((file) => file.conflicted !== true) && expanded && (
            <Button
              variant="ghost"
              size="xs"
              className="shrink-0 rounded-full font-normal text-muted-foreground"
              disabled={git.busy}
              onClick={() =>
                void git.stage(
                  groups.unstaged
                    .filter((file) => file.conflicted !== true)
                    .map((file) => file.path),
                )
              }
              data-action="git-stage-all"
            >
              {t('commit.stageAll')}
            </Button>
          )}
          {!clean && (
            <IconButton
              label={t('commit.title')}
              size="icon-xs"
              aria-expanded={open}
              className="rounded-full text-muted-foreground"
              onClick={() => onOpenChange(!open)}
              data-action="commit-toggle"
            >
              <ChevronDown
                className={cn(
                  'transition-transform duration-200 ease-smooth',
                  !open && 'rotate-180',
                )}
              />
            </IconButton>
          )}
        </div>
        {expanded && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            {status.operation !== undefined && (
              <Callout tone="warning">{operationLabel(status.operation)}</Callout>
            )}
            {groups.external.length > 0 && (
              <Callout tone="warning" data-commit-external>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{t('commit.external', { count: groups.external.length })}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {groups.external
                      .map((file) =>
                        file.outside === true ? `${file.path} (${t('commit.outside')})` : file.path,
                      )
                      .join(t('common.listSeparator'))}
                  </span>
                </span>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-foreground">
                  <Checkbox
                    size="sm"
                    checked={includeExternal}
                    onCheckedChange={(checked) => setIncludeExternal(checked === true)}
                    data-action="git-include-external"
                  />
                  {t('commit.includeExternal')}
                </label>
              </Callout>
            )}
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t('commit.message')}
              aria-label={t('commit.message')}
              className="max-h-40 min-h-14 shrink-0 resize-none rounded-none border-0 bg-transparent px-3 py-1.5 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
              data-commit-message
            />
            {outcome?.kind === 'failed' && (
              <div
                className="mx-2 mb-1.5 flex flex-col gap-1.5 rounded-xl border border-destructive/25 bg-destructive/5 px-2.5 py-2"
                role="alert"
                data-commit-failure={outcome.reason}
              >
                <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <CircleX aria-hidden className="size-3.5 shrink-0" />
                  {failureLabel(outcome)}
                </p>
                {outcome.output !== undefined && outcome.output !== '' && (
                  <pre className="max-h-32 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-soft-foreground">
                    {outcome.output}
                  </pre>
                )}
              </div>
            )}
            {hasStatus && (
              <div className="flex min-w-0 px-3 pb-1.5">
                <FooterStatus git={git} outcome={outcome} />
              </div>
            )}
            <div className="flex min-h-10 shrink-0 items-center gap-1 px-2 pb-2">
              {checks.length > 0 && (
                <ChecksChip
                  checks={checks}
                  workingTree={status.verification?.stagedMatchesWorkingTree === false}
                />
              )}
              <span className="min-w-1 flex-1" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      className="shrink-0 rounded-full px-3"
                      disabled={!ready}
                      onClick={submit}
                      data-action="git-commit"
                    />
                  }
                >
                  {t('commit.submit')}
                </TooltipTrigger>
                <TooltipContent>
                  {t('commit.submit')}
                  <kbd className="ml-1.5 font-sans opacity-70">{SUBMIT_SHORTCUT}</kbd>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
        {!expanded && !clean && hasStatus && (
          <div className="flex min-w-0 px-3 pb-2">
            <FooterStatus git={git} outcome={outcome} />
          </div>
        )}
      </div>
    </section>
  );
}

function Callout({
  tone,
  children,
  className,
  ...props
}: { tone: 'warning'; children: ReactNode } & ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mx-2 mb-1.5 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs',
        tone === 'warning' && 'border-warning/30 bg-warning/5 text-warning',
        className,
      )}
      role="status"
      {...props}
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

function Committed({ outcome }: { outcome: Extract<GitCommitOutcome, { kind: 'committed' }> }) {
  return (
    <span
      className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground"
      role="status"
    >
      <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />
      <span className="truncate">
        {t('commit.committed', { commit: outcome.commit.slice(0, 7) })}
        {outcome.treeChanged === true && <> · {t('commit.treeChanged')}</>}
      </span>
    </span>
  );
}

function FooterStatus({ git, outcome }: { git: GitState; outcome: GitCommitOutcome | undefined }) {
  if (git.error?.kind === 'stale') {
    return (
      <span className="min-w-0 truncate text-xs text-warning" role="status">
        {t('commit.stale')}
      </span>
    );
  }
  if (git.error?.kind === 'failed') {
    return (
      <span className="min-w-0 truncate text-xs text-destructive" role="alert">
        {t('commit.requestFailed', { error: git.error.message })}
      </span>
    );
  }
  if (outcome?.kind === 'committed') return <Committed outcome={outcome} />;
  return null;
}

/** 检查的顺序：最该注意的在前，小标签的图标取最前的那一种。 */
const TONE_ORDER: readonly CheckTone[] = ['failed', 'running', 'stale', 'not_run', 'passed'];

/** 验证记录：一个小标签“检查 通过数/总数”，图标是最该注意的状态；悬停时逐项列出。 */
function ChecksChip({
  checks,
  workingTree,
}: {
  checks: readonly GitVerificationCheck[];
  /** 暂存的不是全部工作树：记录验证的是工作树。 */
  workingTree: boolean;
}) {
  const tones = checks.map((check) => checkTone(check.status));
  const tone = TONE_ORDER.find((candidate) => tones.includes(candidate)) ?? 'not_run';
  const { icon: Icon, className } = TONE[tone];
  const passed = tones.filter((candidate) => candidate === 'passed').length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-border px-2 text-xs text-soft-foreground tabular-nums"
            data-commit-verification
            data-check-tone={tone}
          />
        }
      >
        <Icon aria-hidden className={cn('size-3 shrink-0', className)} />
        <span className="truncate">{t('commit.checks', { passed, total: checks.length })}</span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col items-stretch gap-0.5">
        {checks.map((check, index) => {
          const own = TONE[tones[index] ?? 'not_run'];
          return (
            <span key={check.checkId} className="flex items-center gap-1.5">
              <own.icon aria-hidden className={cn('size-3 shrink-0', own.className)} />
              <span className="min-w-0 truncate">{check.name}</span>
              <span className="ml-auto pl-3 opacity-70">
                {checkLabel(tones[index] ?? 'not_run')}
              </span>
            </span>
          );
        })}
        {workingTree && <span className="opacity-70">{t('commit.verifiedWorkingTree')}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** “已暂存 N/M ⌄”：点开是两组文件，勾上暂存、取消勾选取消暂存；点文件名在 diff 里滚到它。 */
function FilesPopover({
  git,
  total,
  stagedCount,
  onReveal,
}: {
  git: GitState;
  total: number;
  stagedCount: number;
  onReveal: (path: string, staged: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = groupFiles(git.status);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="ml-0.5 shrink-0 gap-0.5 rounded-full px-1.5 font-normal text-muted-foreground tabular-nums"
            data-action="commit-files"
          />
        }
      >
        {t('commit.stagedOf', { staged: stagedCount, total: Math.max(total, stagedCount) })}
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-1 p-1.5" data-commit-files>
        <ScrollFade className="max-h-80 overflow-y-auto [--scroll-fade-size:16px]">
          <FileGroup
            title={t('commit.staged')}
            side="staged"
            files={groups.staged}
            busy={git.busy}
            allLabel={t('commit.unstageAll')}
            onAll={() => void git.unstage(groups.staged.map((file) => file.path))}
            onToggle={(file) => void git.unstage([file.path])}
            onReveal={(file) => {
              setOpen(false);
              onReveal(file.path, true);
            }}
          />
          <FileGroup
            title={t('commit.unstaged')}
            side="unstaged"
            files={groups.unstaged}
            busy={git.busy}
            allLabel={t('commit.stageAll')}
            onAll={() =>
              void git.stage(
                groups.unstaged.filter((file) => file.conflicted !== true).map((file) => file.path),
              )
            }
            onToggle={(file) => void git.stage([file.path])}
            onReveal={(file) => {
              setOpen(false);
              onReveal(file.path, false);
            }}
          />
        </ScrollFade>
      </PopoverContent>
    </Popover>
  );
}

function FileGroup({
  title,
  side,
  files,
  busy,
  allLabel,
  onAll,
  onToggle,
  onReveal,
}: {
  title: string;
  side: 'staged' | 'unstaged';
  files: readonly GitStatusFile[];
  busy: boolean;
  allLabel: string;
  onAll: () => void;
  onToggle: (file: GitStatusFile) => void;
  onReveal: (file: GitStatusFile) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col pb-1" data-commit-group={side}>
      <div className="flex h-7 items-center gap-1 px-1.5 text-xs text-muted-foreground">
        <span className="font-medium">{title}</span>
        <span className="tabular-nums">{files.length}</span>
        {files.length > 1 && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 rounded-full px-1.5 font-normal text-muted-foreground"
            disabled={busy}
            onClick={onAll}
          >
            {allLabel}
          </Button>
        )}
      </div>
      <ul className="flex flex-col">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            side={side}
            busy={busy}
            onToggle={() => onToggle(file)}
            onReveal={() => onReveal(file)}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  side,
  busy,
  onToggle,
  onReveal,
}: {
  file: GitStatusFile;
  side: 'staged' | 'unstaged';
  busy: boolean;
  onToggle: () => void;
  onReveal: () => void;
}) {
  const { name, dir } = splitPath(file.path);
  const Icon = fileIcon(file.path);
  const conflicted = file.conflicted === true;
  const entry = side === 'staged' ? file.staged : file.unstaged;
  return (
    <li
      className="flex h-7 min-w-0 items-center gap-2 rounded-lg px-1.5 hover:bg-muted/60"
      data-commit-file={file.path}
    >
      <Checkbox
        size="sm"
        checked={side === 'staged'}
        disabled={busy || conflicted}
        onCheckedChange={onToggle}
        aria-label={
          side === 'staged'
            ? t('commit.unstageFile', { path: file.path })
            : t('commit.stageFile', { path: file.path })
        }
        data-action={side === 'staged' ? 'git-unstage' : 'git-stage'}
      />
      <button
        type="button"
        onClick={onReveal}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs outline-none focus-visible:underline"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-foreground">{name}</span>
        {dir !== '' && (
          <span dir="rtl" className="min-w-0 truncate text-left text-muted-foreground">
            <bdi dir="ltr">{dir}</bdi>
          </span>
        )}
      </button>
      {conflicted ? (
        <span className="shrink-0 text-xs text-destructive">{t('commit.conflicted')}</span>
      ) : entry?.added !== undefined && entry.removed !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-success">+{entry.added}</span>{' '}
          <span className="text-destructive">−{entry.removed}</span>
        </span>
      ) : (
        <span className="w-3 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
          {statusLetter(file, side)}
        </span>
      )}
    </li>
  );
}
