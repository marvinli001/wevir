import { TranscriptProjection, type WevirClient } from '@wevir/client-sdk';
import {
  type AccountState,
  type MethodParams,
  type MethodResult,
  PortableLocalFilesSchema,
} from '@wevir/protocol';
import { useEffect, useId, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { ZuvVersionRestore } from './zuv-version-restore';

type Preview = MethodResult<'sync.importPrepare'>;
type Category = MethodParams<'sync.recoveryDownload'>['categories'][number];
const GROUPS: Array<{ label: PlainMessageKey; categories: Category[] }> = [
  { label: 'sync.sessions', categories: ['project', 'session', 'event-segment'] },
  { label: 'sync.settings', categories: ['settings'] },
  { label: 'sync.memory', categories: ['memory'] },
  { label: 'sync.rules', categories: ['rule'] },
  { label: 'sync.skills', categories: ['skill-bundle'] },
  { label: 'sync.artifacts', categories: ['artifact'] },
  { label: 'portable.workspace', categories: ['workspace-snapshot'] },
];
function download(name: string, parts: Uint8Array[]) {
  const url = URL.createObjectURL(new Blob(parts.map((part) => new Uint8Array(part))));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.split('/').at(-1) ?? 'wevir-data';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ZuvRecoverySection({
  client,
  account,
}: {
  client: WevirClient;
  account: AccountState;
}) {
  const [open, setOpen] = useState(false);
  const grantId = useId();
  const [info, setInfo] = useState<MethodResult<'sync.recoveryInfo'>>();
  const [recovery, setRecovery] = useState<MethodResult<'sync.recoveryStatus'>>();
  const [snapshot, setSnapshot] = useState<MethodResult<'sync.recoverySnapshot'>>();
  const [projects, setProjects] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [packages, setPackages] = useState<MethodResult<'sync.importList'>['packages']>([]);
  const [entries, setEntries] = useState<MethodResult<'sync.importRead'>>();
  const [importId, setImportId] = useState<string>();
  const [content, setContent] = useState<string>();
  const [mirror, setMirror] = useState<MethodResult<'sync.importConversation'>>();
  const [files, setFiles] = useState<(typeof PortableLocalFilesSchema._output)['files']>([]);
  const messages = useMemo(() => {
    const projection = new TranscriptProjection();
    for (const event of mirror?.events ?? []) projection.apply(event);
    return projection.snapshot().messages;
  }, [mirror]);
  const [stepUpId, setStepUpId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<'complete' | 'delete' | 'detach' | 'export'>();
  const supported = client.supports('sync_recovery');
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (error) {
      setError(describe(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setInfo(undefined);
    setRecovery(undefined);
    setSnapshot(undefined);
    setProjects([]);
    setCategories([]);
    if (open && supported && account.status !== 'signing_in')
      void client.request('sync.recoveryInfo', {}).then(setInfo, () => {});
  }, [client, open, supported, account.status]);
  if (!supported) return null;
  const vaultId = info?.vaultId;
  const readMirror = async (id: string) => {
    setImportId(id);
    setEntries(await client.request('sync.importRead', { importId: id }));
  };
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t('portable.recovery')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('portable.recovery')}</DialogTitle>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} size="sm" onClick={() => setConfirm('export')}>
                {t('portable.export')}
              </Button>
              {capabilities().localFiles && (
                <Button
                  disabled={busy}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      const path = await platformApi().selectFolder();
                      if (path) setPreview(await client.request('sync.importPrepare', { path }));
                    })
                  }
                >
                  {t('portable.import')}
                </Button>
              )}
              <Button
                disabled={busy}
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    setPackages((await client.request('sync.importList', {})).packages);
                  })
                }
              >
                {t('portable.mirrors')}
              </Button>
              {info && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void platformApi().openExternal(info.manageUrl)}
                >
                  {t('portable.devices')}
                </Button>
              )}
            </div>
            {preview && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="break-all text-xs">{preview.path}</p>
                <p>{t('portable.entries', { count: preview.entries })}</p>
                <p className="text-xs text-muted-foreground">{t('portable.plaintext')}</p>
                <details>
                  <summary>
                    {t('portable.omissions')} · {preview.omissionCount ?? preview.omissions.length}
                  </summary>
                  <ul className="space-y-1 text-xs">
                    {preview.omissions.map((value) => (
                      <li key={value} className="break-all">
                        {value}
                      </li>
                    ))}
                  </ul>
                </details>
                {preview.state === 'staged' && (
                  <Button
                    disabled={busy}
                    size="sm"
                    onClick={() =>
                      void run(async () => {
                        const imported = await client.request('sync.importApply', {
                          importId: preview.importId,
                        });
                        setPreview(imported);
                        await readMirror(imported.importId);
                      })
                    }
                  >
                    {t('portable.confirmImport')}
                  </Button>
                )}
              </div>
            )}
            {packages.map((value) => (
              <Button
                key={value.importId}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => readMirror(value.importId))}
              >
                {value.createdAt}
              </Button>
            ))}
            {entries && (
              <div className="space-y-1">
                {entries.entries.map((entry) => (
                  <div key={entry.id} className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                      key={entry.id}
                      variant="ghost"
                      size="sm"
                      className="max-w-full justify-start truncate"
                      onClick={() =>
                        void run(async () => {
                          if (!importId) return;
                          if (entry.kind === 'session') {
                            setMirror(
                              await client.request('sync.importConversation', {
                                importId,
                                sessionId: entry.key,
                              }),
                            );
                            setContent(undefined);
                            return;
                          }
                          const result = await client.request('sync.importEntry', {
                            importId,
                            entryId: entry.id,
                          });
                          const bytes = Uint8Array.from(atob(result.base64), (c) =>
                            c.charCodeAt(0),
                          );
                          const text = new TextDecoder().decode(bytes);
                          if (entry.kind === 'references' && entry.key === 'local-files') {
                            setFiles(PortableLocalFilesSchema.parse(JSON.parse(text)).files);
                            setContent(undefined);
                            return;
                          }
                          if (entry.encoding === 'binary' && entry.kind !== 'memory') {
                            download(entry.path ?? entry.key, [bytes]);
                            return;
                          }
                          if (entry.kind === 'version') {
                            const body = (
                              JSON.parse(text) as { record?: { content?: { markdown?: string } } }
                            ).record?.content;
                            if (body?.markdown !== undefined) {
                              setContent(body.markdown);
                              return;
                            }
                          }
                          setContent(text);
                        })
                      }
                    >
                      {entry.path ?? entry.key}
                    </Button>
                    {entry.kind === 'version' && importId && (
                      <ZuvVersionRestore client={client} importId={importId} entryId={entry.id} />
                    )}
                  </div>
                ))}
                {entries.next !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void run(async () => {
                        if (!importId) return;
                        const next = await client.request('sync.importRead', {
                          importId,
                          after: entries.next,
                        });
                        setEntries({ ...next, entries: [...entries.entries, ...next.entries] });
                      })
                    }
                  >
                    {t('portable.more')}
                  </Button>
                )}
              </div>
            )}
            {content && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                {content}
              </pre>
            )}
            {mirror && (
              <div className="space-y-3">
                <p className="font-medium">{mirror.session.title}</p>
                {messages.map((message) => (
                  <p key={message.id} className="whitespace-pre-wrap break-words">
                    {message.parts
                      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                      .join('\n')}
                  </p>
                ))}
                {mirror.next !== undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!importId) return;
                        const page = await client.request('sync.importConversation', {
                          importId,
                          sessionId: mirror.session.id,
                          afterSeq: mirror.next,
                        });
                        setMirror({ ...page, events: [...mirror.events, ...page.events] });
                      })
                    }
                  >
                    {t('portable.more')}
                  </Button>
                )}
              </div>
            )}
            {files.map((file) => (
              <Button
                key={`${file.key}/${file.path}`}
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!importId) return;
                    const parts: Uint8Array[] = [];
                    for (const entryId of file.parts) {
                      const part = await client.request('sync.importEntry', { importId, entryId });
                      parts.push(Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0)));
                    }
                    download(file.path, parts);
                  })
                }
              >
                {file.path}
              </Button>
            ))}
            {vaultId && account.status === 'signed_in' && (
              <div className="space-y-3 border-t border-border pt-3">
                <p className="break-all font-mono text-xs">
                  {vaultId} · {info.keyEpoch}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void run(async () =>
                        setRecovery(await client.request('sync.unlockKeys', { vaultId })),
                      )
                    }
                  >
                    {t('portable.unlock')}
                  </Button>
                  <Button
                    disabled={busy || !info.eligible}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void run(async () =>
                        setRecovery(await client.request('sync.recoveryRequest', { vaultId })),
                      )
                    }
                  >
                    {t('portable.request')}
                  </Button>
                  <Button
                    disabled={busy}
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void run(async () =>
                        setRecovery(
                          await client.request('sync.recoveryStatus', { vaultId, refresh: true }),
                        ),
                      )
                    }
                  >
                    {t('source.recheck')}
                  </Button>
                  <Button
                    disabled={busy}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void run(async () => {
                        const value = await client.request('sync.recoverySnapshot', {
                          vaultId,
                          ...(snapshot && { jobId: snapshot.jobId }),
                        });
                        setSnapshot(value);
                        setProjects([]);
                      })
                    }
                  >
                    {t('portable.snapshot')}
                  </Button>
                </div>
                {recovery?.request && (
                  <div className="space-y-2 text-xs">
                    <p>{t(`portable.state.${recovery.request.state}`)}</p>
                    <p>
                      {recovery.request.notBefore} · {recovery.request.expiresAt}
                    </p>
                    {recovery.request.state === 'approved' && (
                      <Button disabled={busy} size="sm" onClick={() => setConfirm('complete')}>
                        {t('portable.complete')}
                      </Button>
                    )}
                  </div>
                )}
                {snapshot && (
                  <div className="space-y-2">
                    <p className="break-all font-mono text-xs">{snapshot.restoreId}</p>
                    {GROUPS.map((group) => (
                      <label key={group.label} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={group.categories.every((category) =>
                            categories.includes(category),
                          )}
                          onCheckedChange={(checked) =>
                            setCategories((values) =>
                              checked
                                ? [...new Set([...values, ...group.categories])]
                                : values.filter((value) => !group.categories.includes(value)),
                            )
                          }
                        />
                        {t(group.label)}
                      </label>
                    ))}
                    {snapshot.projectIds.map((projectId) => (
                      <label key={projectId} className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={projects.includes(projectId)}
                          onCheckedChange={(checked) =>
                            setProjects((values) =>
                              checked
                                ? [...values, projectId]
                                : values.filter((id) => id !== projectId),
                            )
                          }
                        />
                        {projectId}
                      </label>
                    ))}
                    <Button
                      disabled={busy || categories.length === 0}
                      size="sm"
                      onClick={() =>
                        void run(async () =>
                          setPreview(
                            await client.request('sync.recoveryDownload', {
                              vaultId,
                              jobId: snapshot.jobId,
                              categories,
                              projectIds: projects,
                            }),
                          ),
                        )
                      }
                    >
                      {t('portable.download')}
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm('detach')}
                  >
                    {t('portable.detach')}
                  </Button>
                  <label
                    htmlFor={grantId}
                    className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground"
                  >
                    <span>{t('portable.stepUp')}</span>
                    <Input
                      id={grantId}
                      aria-label={t('portable.stepUp')}
                      value={stepUpId}
                      type="password"
                      onChange={(event) => setStepUpId(event.target.value)}
                    />
                  </label>
                  <Button
                    disabled={busy || !stepUpId}
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm('delete')}
                  >
                    {t('portable.deleteCloud')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(value) => {
            if (!value) setConfirm(undefined);
          }}
          title={t('portable.recovery')}
          confirmLabel={t('portable.confirm')}
          failure={(error) => error}
          onConfirm={async () => {
            if (confirm === 'export') {
              const directory = capabilities().localFiles
                ? await platformApi().selectFolder()
                : undefined;
              if (directory === null) return;
              setPreview(
                await client.request('sync.exportLocal', { ...(directory && { directory }) }),
              );
            } else if (vaultId && confirm === 'complete' && recovery?.request) {
              setRecovery(
                await client.request('sync.recoveryComplete', {
                  vaultId,
                  requestId: recovery.request.requestId,
                }),
              );
            } else if (vaultId && confirm === 'detach') {
              await client.request('sync.detach', { vaultId });
            } else if (vaultId && confirm === 'delete') {
              await client.request('sync.deleteCloud', { vaultId, stepUpId });
              setStepUpId('');
            }
          }}
        >
          <p>
            {t(
              confirm === 'export'
                ? 'portable.plaintext'
                : confirm === 'complete'
                  ? 'portable.completeConsequence'
                  : confirm === 'delete'
                    ? 'portable.deleteConsequence'
                    : 'portable.detachConsequence',
            )}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
