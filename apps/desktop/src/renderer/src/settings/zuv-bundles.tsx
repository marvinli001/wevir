import {
  isRpcError,
  type RequestArgs,
  type RequestMethod,
  type WevirClient,
} from '@wevir/client-sdk';
import type { MethodResult } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { formatFileSize } from '@/session/shared-files-model';
import { useSyncPresentation } from './sync-presentation';

type Preview = MethodResult<'sync.bundlePreview'>;
type File = MethodResult<'sync.bundleFile'>;
export function ZuvBundles({
  client,
  currentVaultId,
  writable,
}: {
  client: WevirClient;
  currentVaultId?: string;
  writable: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [applying, setApplying] = useState(false);
  const { versionLabel: versionText } = useSyncPresentation(client, open);
  const [vaults, setVaults] = useState<MethodResult<'sync.bundleVaults'>['vaults']>([]),
    [vault, setVault] = useState('');
  const [bundles, setBundles] = useState<MethodResult<'sync.bundles'>['bundles']>([]),
    [next, setNext] = useState<string>(),
    [entity, setEntity] = useState('');
  const [preview, setPreview] = useState<Preview>(),
    [version, setVersion] = useState(''),
    [offset, setOffset] = useState(0);
  const [targets, setTargets] = useState<MethodResult<'sync.bundleTargets'>['targets']>([]),
    [target, setTarget] = useState('');
  const [path, setPath] = useState(''),
    [contents, setContents] = useState<Array<{ opId: string; file: File }>>([]),
    [local, setLocal] = useState<File>(),
    [text, setText] = useState('');
  const [creating, setCreating] = useState(false),
    [confirm, setConfirm] = useState<'apply' | 'delete' | 'keep'>();
  const [versions, setVersions] = useState<Preview['versions']>([]),
    [historyNext, setHistoryNext] = useState<string>();
  const generation = useRef(0);
  const previousVault = useRef(currentVaultId);
  const reset = useCallback(() => {
    const next = ++generation.current;
    setBundles([]);
    setNext(undefined);
    setEntity('');
    setPreview(undefined);
    setVersion('');
    setOffset(0);
    setTargets([]);
    setTarget('');
    setPath('');
    setContents([]);
    setLocal(undefined);
    setText('');
    setCreating(false);
    setConfirm(undefined);
    setVersions([]);
    setHistoryNext(undefined);
    setError(undefined);
    setBusy(false);
    setApplying(false);
    return next;
  }, []);
  useEffect(() => {
    if (previousVault.current !== currentVaultId) {
      previousVault.current = currentVaultId;
      reset();
      setVault('');
      setVaults([]);
      setOpen(false);
    }
  }, [currentVaultId, reset]);
  const request = async <M extends RequestMethod>(method: M, ...args: RequestArgs<M>) => {
    const own = generation.current;
    const value = await client.request(method, ...args);
    if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
    return value;
  };
  const canWrite = writable && vault === currentVaultId;
  const run = async (action: () => Promise<void>) => {
    const own = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      if (own === generation.current) setError(describe(reason));
    } finally {
      if (own === generation.current) setBusy(false);
    }
  };
  const load = async (vaultId: string, after?: string) => {
    const own = generation.current;
    const page = await request('sync.bundles', { vaultId, ...(after && { after }) });
    if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
    setBundles((previous) => (after ? [...previous, ...page.bundles] : page.bundles));
    setNext(page.next);
  };
  const loadVersions = async (vaultId: string, entityId: string, after?: string) => {
    const own = generation.current;
    const page = await request('sync.bundleVersions', {
      vaultId,
      entityId,
      ...(after && { after }),
    });
    if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
    setVersions((old) => [
      ...new Map(
        (after ? [...old, ...page.versions] : page.versions).map((item) => [item.opId, item]),
      ).values(),
    ]);
    setHistoryNext(page.next);
  };
  const inspect = async (vaultId: string, entityId: string, fileOffset = 0, opId?: string) => {
    const own = generation.current;
    const data = await request('sync.bundlePreview', {
      vaultId,
      entityId,
      fileOffset,
      ...(opId && { opId }),
    });
    if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
    setPreview(data);
    setOffset(fileOffset);
    setVersion(opId ?? data.heads[0] ?? '');
    if (!opId) {
      await loadVersions(vaultId, entityId);
      if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
      setVersions((old) => [
        ...new Map([...old, ...data.versions].map((item) => [item.opId, item])).values(),
      ]);
    }
    if (writable && vaultId === currentVaultId) {
      const choices = (await request('sync.bundleTargets', { vaultId, entityId })).targets;
      if (own !== generation.current) throw new DOMException('Superseded request', 'AbortError');
      setTargets(choices);
      setTarget(data.binding?.targetId ?? choices[0]?.targetId ?? '');
    } else {
      setTargets([]);
      setTarget('');
    }
  };
  const read = async (filePath: string) => {
    setPath(filePath);
    setLocal(undefined);
    setCreating(false);
    if (!preview) return;
    const choices = [
      ...preview.versions.filter((item) => item.opId === version),
      ...versions.filter((item) => item.opId !== version && preview.heads.includes(item.opId)),
    ]
      .filter((item) => item.files.some((file) => file.path === filePath))
      .slice(0, 2);
    const own = generation.current;
    const values = await Promise.all(
      choices.map(async (item) => ({
        opId: item.opId,
        file: await request('sync.bundleFile', {
          vaultId: vault,
          entityId: entity,
          opId: item.opId,
          path: filePath,
        }),
      })),
    );
    if (own === generation.current) setContents(values);
  };
  const refresh = async () => {
    await inspect(vault, entity);
    await load(vault);
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          const own = reset();
          setOpen(true);
          setVaults([]);
          setVault('');
          void run(async () => {
            const all = (await request('sync.bundleVaults', {})).vaults;
            if (own !== generation.current)
              throw new DOMException('Superseded request', 'AbortError');
            setVaults(all);
            const id =
              all.find((item) => item.vaultId === currentVaultId)?.vaultId ?? all[0]?.vaultId ?? '';
            setVault(id);
            if (id) await load(id);
            else setBundles([]);
          });
        }}
      >
        {t('sync.bundles')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-4xl"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('sync.bundles')}</DialogTitle>
          </DialogHeader>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1">
            {vaults.length > 1 && (
              <Select
                value={vault}
                disabled={busy}
                aria-label={t('sync.localData')}
                options={vaults.map((item, index) => ({
                  value: item.vaultId,
                  label: item.active
                    ? t('sync.currentAccount')
                    : [
                        item.projects.join(' · ') || `${t('sync.localData')} ${index + 1}`,
                        item.lastSyncAt
                          ? new Date(item.lastSyncAt).toLocaleDateString(currentLocale())
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                }))}
                onValueChange={(id) => {
                  reset();
                  setVault(id);
                  void run(() => load(id));
                }}
              />
            )}
            {bundles.length ? (
              <Select
                value={entity}
                disabled={busy}
                aria-label={t('sync.choosePackage')}
                options={[
                  { value: '', label: t('sync.choosePackage') },
                  ...bundles.map((item) => ({
                    value: item.entityId,
                    label: item.binding ? `${item.name} · ${t('sync.bound')}` : item.name,
                  })),
                ]}
                onValueChange={(id) => {
                  setEntity(id);
                  setPreview(undefined);
                  setContents([]);
                  setLocal(undefined);
                  setCreating(false);
                  setPath('');
                  if (id) void run(() => inspect(vault, id));
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {busy ? t('common.loading') : t('sync.noBundles')}
              </p>
            )}
            {next && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => load(vault, next))}
              >
                {t('sync.moreConflicts')}
              </Button>
            )}
            {preview && (
              <>
                <Select
                  value={version}
                  disabled={busy}
                  aria-label={t('sync.selectVersion')}
                  options={versions.map((item, index) => ({
                    value: item.opId,
                    label: `${versionText(item, preview.binding?.revision, index)}${item.deleted ? ` · ${t('rail.outputs.kind.deleted')}` : ''}`,
                  }))}
                  onValueChange={(id) => {
                    setVersion(id);
                    setContents([]);
                    setLocal(undefined);
                    setPath('');
                    setCreating(false);
                    void run(() => inspect(vault, entity, 0, id));
                  }}
                />
                {historyNext && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => loadVersions(vault, entity, historyNext))}
                  >
                    {t('sync.moreVersions')}
                  </Button>
                )}
                {canWrite && targets.length > 0 && (
                  <div className="space-y-2">
                    <Select
                      value={target}
                      disabled={busy || !!preview.binding?.pending}
                      aria-label={t('sync.packageTarget')}
                      options={targets.map((item) => ({
                        value: item.targetId,
                        label: item.managed ? t('sync.managedCopy') : item.name,
                      }))}
                      onValueChange={(id) => {
                        setTarget(id);
                        setLocal(undefined);
                        setCreating(false);
                      }}
                    />
                    <p className="break-all text-xs text-muted-foreground">
                      {targets.find((item) => item.targetId === target)?.path}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy || !version || !target || !!preview.binding?.pending}
                        onClick={() => setConfirm('apply')}
                      >
                        {t(
                          preview.binding && target !== preview.binding.targetId
                            ? 'sync.rebindPackage'
                            : 'sync.applyPackage',
                        )}
                      </Button>
                      {preview.binding && target === preview.binding.targetId && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            !targets.some((item) => item.targetId === preview.binding?.targetId)
                          }
                          onClick={() => setConfirm('keep')}
                        >
                          {t('sync.keepLocalPackage')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {preview.binding && !canWrite && (
                  <p className="break-all text-xs text-muted-foreground">{preview.binding.path}</p>
                )}
                {preview.binding?.pending && (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      preview.binding.pending.paused
                        ? 'sync.applyPaused'
                        : preview.binding.pending.state === 'conflict'
                          ? 'sync.applyConflict'
                          : 'sync.applyingPackage',
                    )}
                  </p>
                )}
                {preview.binding?.pending && canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          'sync.retryBundle',
                          {
                            vaultId: vault,
                            entityId: entity,
                            opId: preview.binding?.pending?.opId as string,
                          },
                          { timeoutMs: 180000 },
                        );
                        await refresh();
                      })
                    }
                  >
                    {t('sync.resumeApply')}
                  </Button>
                )}
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {preview.versions
                    .find((item) => item.opId === version)
                    ?.files.map((file) => (
                      <li
                        key={file.path}
                        className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-sm"
                      >
                        <button
                          type="button"
                          className="min-w-0 truncate text-left hover:underline focus-visible:focus-field"
                          disabled={busy}
                          onClick={() => void run(() => read(file.path))}
                        >
                          {file.path}
                        </button>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatFileSize(file.bytes, currentLocale())}
                        </span>
                      </li>
                    ))}
                </ul>
                {offset > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(() => inspect(vault, entity, Math.max(0, offset - 100), version))
                    }
                  >
                    {t('usage.page.prev')}
                  </Button>
                )}
                {preview.versions.some((item) => item.fileCount > offset + 100) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => inspect(vault, entity, offset + 100, version))}
                  >
                    {t('sync.moreFiles')}
                  </Button>
                )}
                {contents.length > 0 && (
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {contents.map((item, index) => (
                      <div key={item.opId} className="min-w-0 space-y-1">
                        <span className="text-xs text-muted-foreground">
                          {versionText(
                            versions.find((version) => version.opId === item.opId) ?? item,
                            preview.binding?.revision,
                            index,
                          )}{' '}
                          · {path}
                        </span>
                        {item.file.binary ? (
                          <p className="break-all font-mono text-xs">
                            {t('sync.binaryFile')} · {item.file.sha256}
                          </p>
                        ) : (
                          <Textarea
                            readOnly
                            aria-label={`${versionText(versions.find((version) => version.opId === item.opId) ?? item, preview.binding?.revision, index)} ${path}`}
                            value={item.file.text ?? ''}
                            className="h-40 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                          />
                        )}
                        {item.file.truncated && (
                          <p className="text-xs text-muted-foreground">{t('sync.truncatedFile')}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {path &&
                  preview.binding &&
                  target === preview.binding.targetId &&
                  canWrite &&
                  !preview.binding.pending && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const file = await request('sync.bundleFile', {
                            vaultId: vault,
                            entityId: entity,
                            path,
                          });
                          setLocal(file);
                          setText(file.text ?? '');
                          setCreating(false);
                        })
                      }
                    >
                      {t('sync.currentFiles')}
                    </Button>
                  )}
                {preview.binding &&
                  target === preview.binding.targetId &&
                  canWrite &&
                  !preview.binding.pending &&
                  targets.find((item) => item.targetId === target)?.kind === 'directory' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setCreating(true);
                        setLocal(undefined);
                        setPath('');
                        setText('');
                      }}
                    >
                      {t('sync.newFile')}
                    </Button>
                  )}
                {creating && (
                  <Input
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    maxLength={1024}
                    aria-label={t('sync.fileName')}
                    disabled={busy}
                  />
                )}
                {(local || creating) && (
                  <div className="space-y-2">
                    {local?.binary ? (
                      <p className="text-sm">{t('sync.binaryFile')}</p>
                    ) : (
                      <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        readOnly={local?.truncated}
                        aria-label={path || t('sync.fileName')}
                        maxLength={128 * 1024}
                        disabled={busy}
                        className="h-48 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                      />
                    )}
                    {local?.truncated && (
                      <p className="text-xs text-muted-foreground">{t('sync.truncatedFile')}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={
                          busy ||
                          !canWrite ||
                          target !== preview.binding?.targetId ||
                          !path ||
                          local?.binary ||
                          local?.truncated
                        }
                        onClick={() =>
                          void run(async () => {
                            const data = local ?? targets.find((item) => item.targetId === target);
                            if (!data) return;
                            await request(
                              'sync.editBundleFile',
                              {
                                vaultId: vault,
                                entityId: entity,
                                path,
                                text,
                                fingerprint: data.fingerprint as string,
                                localRevision: local?.localRevision ?? preview.binding?.revision,
                              },
                              { timeoutMs: 180000 },
                            );
                            setLocal(undefined);
                            setCreating(false);
                            setContents([]);
                            await refresh();
                          })
                        }
                      >
                        {t('sync.saveFile')}
                      </Button>
                      {local && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy || !canWrite || target !== preview.binding?.targetId}
                          onClick={() => setConfirm('delete')}
                        >
                          {t('sync.deleteFile')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            {applying && entity && canWrite && (
              <Button
                variant="outline"
                onClick={() =>
                  void client
                    .request('sync.cancelBundle', { vaultId: vault, entityId: entity })
                    .catch((reason) => setError(describe(reason)))
                }
              >
                {t('sync.pauseApply')}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirm && preview && (
        <ConfirmDialog
          open
          title={t(
            confirm === 'apply'
              ? 'sync.applyPackage'
              : confirm === 'keep'
                ? 'sync.keepLocalPackage'
                : 'sync.deleteFile',
          )}
          confirmLabel={t(
            confirm === 'apply'
              ? 'sync.applyPackage'
              : confirm === 'keep'
                ? 'sync.keepLocalPackage'
                : 'sync.deleteFile',
          )}
          onOpenChange={(value) => {
            if (!value) setConfirm(undefined);
          }}
          failure={(value) => value}
          onConfirm={async () => {
            const action = confirm;
            const own = generation.current;
            setBusy(true);
            setError(undefined);
            setApplying(action === 'apply');
            if (action === 'apply') setConfirm(undefined);
            try {
              if (action === 'apply') {
                const selected = targets.find((item) => item.targetId === target);
                if (!selected) return;
                await request(
                  'sync.applyBundle',
                  {
                    vaultId: vault,
                    entityId: entity,
                    selectedOpId: version,
                    expectedHeads: preview.heads,
                    targetId: target,
                    fingerprint: selected.fingerprint,
                    localRevision: preview.binding?.revision,
                    expectedTargetId: preview.binding?.targetId,
                  },
                  { timeoutMs: 180000 },
                );
              } else if (action === 'keep') {
                const selected = targets.find(
                  (item) => item.targetId === preview.binding?.targetId,
                );
                if (!selected) return;
                await request(
                  'sync.keepLocalBundle',
                  {
                    vaultId: vault,
                    entityId: entity,
                    expectedHeads: preview.heads,
                    targetId: selected.targetId,
                    fingerprint: selected.fingerprint,
                    localRevision: preview.binding?.revision,
                  },
                  { timeoutMs: 180000 },
                );
              } else if (local)
                await request(
                  'sync.editBundleFile',
                  {
                    vaultId: vault,
                    entityId: entity,
                    path,
                    deleted: true,
                    fingerprint: local.fingerprint as string,
                    localRevision: local.localRevision,
                  },
                  { timeoutMs: 180000 },
                );
              setConfirm(undefined);
              setLocal(undefined);
              setCreating(false);
              setContents([]);
            } catch (reason) {
              if (action !== 'apply') throw reason;
              if (
                own === generation.current &&
                !(isRpcError(reason, 'SYNC_FAILED') && reason.data?.code === 'APPLICATION_PAUSED')
              )
                setError(describe(reason));
            } finally {
              await refresh().catch((reason: unknown) => {
                if (own === generation.current) setError(describe(reason));
              });
              if (own === generation.current) {
                setBusy(false);
                setApplying(false);
              }
            }
          }}
        >
          <p>
            {t(
              confirm === 'apply'
                ? 'sync.applyPackageConsequences'
                : confirm === 'keep'
                  ? 'sync.keepLocalPackageConsequences'
                  : 'sync.deleteFileConsequences',
            )}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
