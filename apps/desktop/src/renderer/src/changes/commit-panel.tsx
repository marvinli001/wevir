// “变更”窗格底部的提交区（0.67.0，ADR-0009）：已暂存与未暂存的文件逐个暂存、取消暂存；其他已暂存内容（不是在这里暂存的、
// 目录外的）单独列出，勾选才一起提交；同一代码状态的验证记录只显示、不挡提交；提交失败时显示原因与 git 的输出，什么都不回滚。
// 点文件名在“已暂存”或“未提交”的 diff 里滚到它。

import type { GitCommitOutcome, GitStatusFile } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, Minus, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import {
  type CheckTone,
  canCommit,
  checkLabel,
  checkTone,
  failureLabel,
  groupFiles,
  operationLabel,
  statusLetter,
} from './commit-model';
import type { GitState } from './git-data';

const TONE_CLASS: Record<CheckTone, string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  stale: 'text-warning',
  running: 'text-muted-foreground',
  not_run: 'text-muted-foreground',
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
  const checks = status.verification?.checks ?? [];

  return (
    <section
      className="flex max-h-[55%] shrink-0 flex-col border-t border-border"
      data-commit-panel
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-left text-xs font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 transition-transform duration-200 ease-smooth',
            open && 'rotate-90',
          )}
        />
        <span>{t('commit.title')}</span>
        <span className="font-normal text-muted-foreground tabular-nums">
          {t('commit.summary', {
            staged: groups.staged.length + groups.external.filter((file) => file.outside).length,
            unstaged: groups.unstaged.length,
          })}
        </span>
        {status.branch !== undefined && (
          <span className="ml-auto min-w-0 truncate font-mono font-normal text-muted-foreground">
            {status.branch}
          </span>
        )}
      </button>
      {open && (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {status.operation !== undefined && (
            <p className="text-xs text-warning" role="status">
              {operationLabel(status.operation)}
            </p>
          )}
          <FileGroup
            title={t('commit.staged')}
            files={groups.staged}
            side="staged"
            busy={git.busy}
            allLabel={t('commit.unstageAll')}
            onAll={() => void git.unstage(groups.staged.map((file) => file.path))}
            action={(file) => (
              <IconButton
                label={t('commit.unstageFile', { path: file.path })}
                size="icon-xs"
                disabled={git.busy}
                onClick={() => void git.unstage([file.path])}
                data-action="git-unstage"
              >
                <Minus />
              </IconButton>
            )}
            onReveal={(file) => onReveal(file.path, true)}
          />
          <FileGroup
            title={t('commit.unstaged')}
            files={groups.unstaged}
            side="unstaged"
            busy={git.busy}
            allLabel={t('commit.stageAll')}
            onAll={() =>
              void git.stage(
                groups.unstaged.filter((file) => file.conflicted !== true).map((file) => file.path),
              )
            }
            action={(file) =>
              file.conflicted === true ? null : (
                <IconButton
                  label={t('commit.stageFile', { path: file.path })}
                  size="icon-xs"
                  disabled={git.busy}
                  onClick={() => void git.stage([file.path])}
                  data-action="git-stage"
                >
                  <Plus />
                </IconButton>
              )
            }
            onReveal={(file) => onReveal(file.path, false)}
          />
          {groups.external.length > 0 && (
            <div
              className="flex flex-col gap-1 rounded-lg border border-warning/40 px-2 py-1.5"
              data-commit-external
            >
              <p className="text-xs text-warning">
                {t('commit.external', { count: groups.external.length })}
              </p>
              <ul className="flex flex-col">
                {groups.external.map((file) => (
                  <li key={file.path} className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
                    <span className="w-3 shrink-0 text-center font-mono text-muted-foreground">
                      {statusLetter(file, 'staged')}
                    </span>
                    <span dir="rtl" className="min-w-0 truncate text-left font-mono">
                      <bdi dir="ltr">{file.path}</bdi>
                    </span>
                    {file.outside === true && (
                      <span className="shrink-0 text-muted-foreground">
                        · {t('commit.outside')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  size="sm"
                  checked={includeExternal}
                  onCheckedChange={(checked) => setIncludeExternal(checked === true)}
                  data-action="git-include-external"
                />
                {t('commit.includeExternal')}
              </label>
            </div>
          )}
          {status.verification !== undefined && (
            <div className="flex flex-col gap-0.5" data-commit-verification>
              <p className="text-xs text-muted-foreground">
                {t('commit.verification')}
                {!status.verification.stagedMatchesWorkingTree && checks.length > 0 && (
                  <span> · {t('commit.verifiedWorkingTree')}</span>
                )}
              </p>
              {checks.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('commit.noChecks')}</p>
              ) : (
                <ul className="flex flex-col">
                  {checks.map((check) => {
                    const tone = checkTone(check.status);
                    return (
                      <li
                        key={check.checkId}
                        className="flex h-5 min-w-0 items-center gap-2 text-xs"
                        data-check-tone={tone}
                      >
                        <span className="min-w-0 truncate">{check.name}</span>
                        <span className={cn('ml-auto shrink-0', TONE_CLASS[tone])}>
                          {checkLabel(tone)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
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
            className="max-h-40 min-h-14 text-xs md:text-xs"
            data-commit-message
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!ready} onClick={submit} data-action="git-commit">
              {t('commit.submit')}
            </Button>
            {git.error?.kind === 'stale' && (
              <span className="text-xs text-warning" role="status">
                {t('commit.stale')}
              </span>
            )}
            {git.error?.kind === 'failed' && (
              <span className="min-w-0 truncate text-xs text-destructive" role="alert">
                {t('commit.requestFailed', { error: git.error.message })}
              </span>
            )}
            {outcome?.kind === 'committed' && (
              <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
                {t('commit.committed', { commit: outcome.commit.slice(0, 7) })}
                {outcome.treeChanged === true && <> · {t('commit.treeChanged')}</>}
              </span>
            )}
          </div>
          {outcome?.kind === 'failed' && (
            <div className="flex flex-col gap-1" role="alert" data-commit-failure={outcome.reason}>
              <p className="text-xs text-destructive">{failureLabel(outcome)}</p>
              {outcome.output !== undefined && outcome.output !== '' && (
                <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-soft-foreground">
                  {outcome.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FileGroup({
  title,
  files,
  side,
  busy,
  allLabel,
  onAll,
  action,
  onReveal,
}: {
  title: string;
  files: readonly GitStatusFile[];
  side: 'staged' | 'unstaged';
  busy: boolean;
  allLabel: string;
  onAll: () => void;
  action: (file: GitStatusFile) => ReactNode;
  onReveal: (file: GitStatusFile) => void;
}) {
  return (
    <div className="flex flex-col" data-commit-group={side}>
      <div className="flex h-6 items-center gap-1 text-xs text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums">{files.length}</span>
        {files.length > 1 && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 px-1.5 text-xs font-normal text-muted-foreground"
            disabled={busy}
            onClick={onAll}
          >
            {allLabel}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="pl-4 text-xs text-muted-foreground">{t('commit.none')}</p>
      ) : (
        <ul className="flex flex-col">
          {files.map((file) => (
            <li
              key={file.path}
              className="group/row flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-0.5 hover:bg-muted/60"
              data-commit-file={file.path}
            >
              <span
                className={cn(
                  'w-4 shrink-0 text-center font-mono text-xs',
                  file.conflicted === true ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {statusLetter(file, side)}
              </span>
              <button
                type="button"
                onClick={() => onReveal(file)}
                className="min-w-0 flex-1 truncate text-left font-mono text-xs outline-none focus-visible:underline"
                title={file.path}
              >
                <span dir="rtl" className="block truncate text-left">
                  <bdi dir="ltr">{file.path}</bdi>
                </span>
              </button>
              {file.conflicted === true && (
                <span className="shrink-0 text-xs text-destructive">{t('commit.conflicted')}</span>
              )}
              <SideStats file={file} side={side} />
              <span className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                {action(file)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SideStats({ file, side }: { file: GitStatusFile; side: 'staged' | 'unstaged' }) {
  const entry = side === 'staged' ? file.staged : file.unstaged;
  if (entry?.added === undefined || entry.removed === undefined) return null;
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-success">+{entry.added}</span>{' '}
      <span className="text-destructive">−{entry.removed}</span>
    </span>
  );
}
