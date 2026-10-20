// “依赖”卡片的对话框（0.70.0）：安装前的确认（命令、目录、会执行的脚本、凭据，用户确认后 Host 才跑）、安装的完整输出
// （`readiness.output` 分页读，凭据已遮住）、一项的依据，与存一个安装用的凭据（值进 Host 的秘密存储，不回显）。

import type {
  InstallPlan,
  InstallRun,
  ReadinessItem,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  CREDENTIAL_LABELS,
  INSTALL_LABELS,
  planFolder,
  readinessReasonLabel,
  SCRIPT_LABELS,
  STATUS_LABELS,
} from './readiness-model';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** 安装前的确认。确认后发 `readiness.install`（`acceptScripts: true`）；方案变了 Host 回错误，关掉后卡片重读。 */
export function InstallDialog({
  workspaceId,
  sessionId,
  root,
  plan,
  onClose,
}: {
  workspaceId: WorkspaceId;
  sessionId?: SessionId;
  root: string;
  plan: InstallPlan;
  onClose: (started: boolean) => void;
}) {
  const { client } = useHostConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const install = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('readiness.install', {
        workspaceId,
        ...(sessionId && { sessionId }),
        planId: plan.id,
        acceptScripts: true,
      });
      onClose(true);
    } catch (reason) {
      setBusy(false);
      setError(t('readiness.failed', { error: describe(reason) }));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose(false)}>
      <DialogContent className="sm:max-w-lg" data-testid="readiness-install">
        <DialogHeader>
          <DialogTitle>{t('readiness.install.title')}</DialogTitle>
          <DialogDescription render={<div />}>
            <dl className="mt-1">
              <Field label={t('readiness.field.command')}>
                <code className="font-mono text-foreground">{plan.command}</code>
              </Field>
              <Field label={t('readiness.field.folder')}>
                <span className="font-mono">{planFolder(plan.path)}</span>
                <span className="block truncate text-xs" title={root}>
                  {root}
                </span>
              </Field>
              <Field label={t('readiness.field.lockfile')}>
                {plan.writesLockfile
                  ? t('readiness.lockfile.writes')
                  : (plan.lockfile ?? t('readiness.none'))}
              </Field>
              <Field label={t('readiness.field.projectScripts')}>
                {plan.scripts.project.length > 0 ? (
                  <span className="font-mono">{plan.scripts.project.join(', ')}</span>
                ) : (
                  t('readiness.none')
                )}
              </Field>
              <Field label={t('readiness.field.dependencyScripts')}>
                {t(SCRIPT_LABELS[plan.scripts.dependencies])}
              </Field>
              {plan.credentials.length > 0 && (
                <Field label={t('readiness.field.credentials')}>
                  <ul>
                    {plan.credentials.map((item) => (
                      <li key={item.name} data-credential-source={item.source}>
                        <span className="font-mono">{item.name}</span> ·{' '}
                        <span className={item.source === 'missing' ? 'text-warning' : undefined}>
                          {t(CREDENTIAL_LABELS[item.source])}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
            </dl>
          </DialogDescription>
        </DialogHeader>
        <p
          role="note"
          className="rounded-md bg-warning/10 px-3 py-2 text-sm text-foreground"
          data-testid="readiness-scripts-warning"
        >
          {t('readiness.install.scriptsWarning')}
        </p>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void install()} disabled={!client || busy} data-confirm>
            {t('readiness.install.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Page {
  text: string;
  next: number;
  more: boolean;
  dropped: boolean;
}

/** 一次安装的完整输出；还在跑时 `refreshKey`（已写的字节数）变了就接着读。 */
export function InstallOutputDialog({ run, onClose }: { run: InstallRun; onClose: () => void }) {
  const { client } = useHostConnection();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async (offset: number, previous?: Page) => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.request('readiness.output', { runId: run.id, offset });
      setPage({
        text: (previous?.text ?? '') + result.text,
        next: result.next,
        more: result.more,
        dropped: previous?.dropped ?? result.from > offset,
      });
    } catch (reason) {
      setError(t('readiness.failed', { error: describe(reason) }));
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换记录时从头读，还在跑时输出变多就接着读。
  useEffect(() => {
    if (page && run.status === 'running') {
      if (!page.more && run.bytes > page.next) void load(page.next, page);
      return;
    }
    setPage(undefined);
    setError(undefined);
    void load(0);
  }, [client, run.id, run.bytes, run.status]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="readiness-output">
        <DialogHeader>
          <DialogTitle>{t('readiness.output')}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{run.command}</span> · {t(INSTALL_LABELS[run.status])}
            {run.exitCode !== undefined && run.exitCode !== null && ` · exit ${run.exitCode}`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : page === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="min-w-0 space-y-2">
            {page.dropped && (
              <p className="text-xs text-muted-foreground">{t('verification.output.dropped')}</p>
            )}
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {page.text === '' ? t('verification.output.empty') : page.text}
            </pre>
            {page.more && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load(page.next, page)}
              >
                {t('verification.output.more')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 一项的依据：读了哪些文件、跑了哪些命令。 */
export function EvidenceDialog({ item, onClose }: { item: ReadinessItem; onClose: () => void }) {
  const reason = readinessReasonLabel(item.reason);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="readiness-evidence">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {reason ? t(reason) : t(STATUS_LABELS[item.status])}
          </DialogDescription>
        </DialogHeader>
        <dl>
          <Field label={t('readiness.field.folder')}>
            <span className="font-mono">{planFolder(item.path)}</span>
          </Field>
          {item.required !== undefined && (
            <Field label={t('readiness.field.required')}>
              <span className="font-mono">{item.required}</span>
            </Field>
          )}
          {item.found !== undefined && (
            <Field label={t('readiness.field.found')}>
              <span className="font-mono">{item.found}</span>
            </Field>
          )}
        </dl>
        {item.evidence.length > 0 && (
          <div className="min-w-0">
            <p className="mb-1 text-sm font-medium">{t('readiness.evidence')}</p>
            <ul className="space-y-1.5">
              {item.evidence.map((evidence, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 依据没有 ID，顺序固定。
                <li key={index} className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
                  <span className="break-all">
                    {evidence.kind === 'command' ? `$ ${evidence.command ?? ''}` : evidence.path}
                  </span>
                  {evidence.exitCode !== undefined && evidence.exitCode !== null && (
                    <span className="text-muted-foreground"> · exit {evidence.exitCode}</span>
                  )}
                  {evidence.detail && (
                    <span className="block text-muted-foreground">{evidence.detail}</span>
                  )}
                  {evidence.output && (
                    <span className="block whitespace-pre-wrap break-words text-muted-foreground">
                      {evidence.output}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 存一个安装用的凭据（私有仓库的令牌）。值只发给 Host，结果只有名字。 */
export function CredentialDialog({
  workspaceId,
  name: initialName,
  onClose,
}: {
  workspaceId: WorkspaceId;
  name: string;
  onClose: (saved: boolean) => void;
}) {
  const { client } = useHostConnection();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && value !== '';

  const save = async () => {
    if (!client || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('readiness.setCredential', { workspaceId, name, value });
      setValue('');
      onClose(true);
    } catch (reason) {
      setBusy(false);
      setError(t('readiness.failed', { error: describe(reason) }));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md" data-testid="readiness-credential">
        <DialogHeader>
          <DialogTitle>{t('readiness.credential.title')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1 text-sm">
            <label htmlFor={`${id}-name`} className="block text-muted-foreground">
              {t('readiness.credential.name')}
            </label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1 text-sm">
            <label htmlFor={`${id}-value`} className="block text-muted-foreground">
              {t('readiness.credential.value')}
            </label>
            <Input
              id={`${id}-value`}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!client || busy || !valid}>
              {t('readiness.credential.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
