import { hostSupports } from '@wevir/client-sdk';
import type { Plugin, PluginPreview } from '@wevir/protocol';
import { FileArchive, FolderPlus, LoaderCircle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import type { InstallSourceKind } from '../../../shared/desktop-api.js';
import { inputValues, missingRequired, newlyInstalled, planAdd } from './add-flow';
import { PluginHooks } from './plugin-hooks';
import { InputField } from './plugin-inputs';
import { usePluginsContext } from './plugins-context';

export interface AddRequest {
  id: number;
  path?: string;
  error?: string;
}

type Step =
  | { name: 'choose' }
  | { name: 'working'; path: string }
  | { name: 'confirm'; path: string; preview: PluginPreview; installed?: Plugin };

export function AddDialog({
  request,
  packages,
  onClose,
}: {
  request: AddRequest | null;
  packages: boolean;
  onClose: () => void;
}) {
  return (
    request && (
      <AddDialogBody key={request.id} request={request} packages={packages} onClose={onClose} />
    )
  );
}

function AddDialogBody({
  request,
  packages,
  onClose,
}: {
  request: AddRequest;
  packages: boolean;
  onClose: () => void;
}) {
  const { client, list, plugins, data, notify } = usePluginsContext();
  const [step, setStep] = useState<Step>(
    request.path === undefined ? { name: 'choose' } : { name: 'working', path: request.path },
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(request.error);
  const working = step.name === 'working';

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时开始一次。
  useEffect(() => {
    if (request.path !== undefined) void begin(request.path);
  }, []);

  const choose = async (kind: InstallSourceKind) => {
    setError(undefined);
    try {
      const path = await platformApi().selectInstallSource(kind);
      if (path !== null) void begin(path);
    } catch (reason) {
      setError(t('plugins.add.inspectFailed', { error: describe(reason) }));
    }
  };

  const begin = async (path: string) => {
    setStep({ name: 'working', path });
    setError(undefined);
    try {
      const inspection = await platformApi().inspectInstallSource(path);
      const plan = planAdd(inspection, packages);
      if (plan.action === 'error') {
        setStep({ name: 'choose' });
        setError(
          t(
            plan.reason === 'packages'
              ? 'plugins.add.packagesUnsupported'
              : 'plugins.add.unsupported',
          ),
        );
      } else if (plan.action === 'skill') {
        const result = await client.request('skill.install', { path });
        const added = newlyInstalled(list.skills, result.skills);
        data.apply(() => result);
        notify({
          tone: 'success',
          text: t('plugins.add.skills', {
            names: added.map((skill) => skill.name).join(t('common.listSeparator')),
          }),
        });
        onClose();
      } else if (!packages || !hostSupports(client.hello.features, 'plugin_preview')) {
        setStep({ name: 'choose' });
        setError(t('plugins.add.previewUnsupported'));
      } else {
        const preview = await client.request('plugin.preview', { path });
        const installed = plugins.get(preview.id);
        setValues({});
        const next: Step = { name: 'confirm', path, preview, ...(installed && { installed }) };
        if (installed || preview.inputs.length > 0 || preview.hooks.length > 0) setStep(next);
        else await installPlugin(path, preview, false, next);
      }
    } catch (reason) {
      setStep({ name: 'choose' });
      setError(t('plugins.add.inspectFailed', { error: describe(reason) }));
    }
  };

  const installPlugin = async (
    path: string,
    preview: PluginPreview,
    replace: boolean,
    back: Step,
  ) => {
    setStep({ name: 'working', path });
    setError(undefined);
    try {
      const inputs = inputValues(values);
      const result = await client.request('plugin.install', {
        path,
        expectedDigest: preview.digest,
        ...(Object.keys(inputs).length > 0 && { inputs }),
        ...(replace && { replace: true }),
      });
      await data.refresh();
      const ignored =
        result.ignored.length > 0
          ? t('plugins.add.ignored', { items: result.ignored.join(t('common.listSeparator')) })
          : '';
      const main = replace
        ? t('plugins.add.upgraded', {
            name: result.plugin.name,
            version: `v${result.plugin.version}`,
          })
        : t('plugins.add.installed', { name: result.plugin.name });
      notify({ tone: 'success', text: main + ignored });
      onClose();
    } catch (reason) {
      setStep(back);
      setError(t('plugins.add.failed', { error: describe(reason) }));
    }
  };

  const missing =
    step.name === 'confirm'
      ? missingRequired(step.preview, values).filter(
          (key) => !step.installed?.inputs.some((input) => input.key === key && input.set),
        )
      : [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step.name === 'confirm' && missing.length === 0)
      void installPlugin(step.path, step.preview, step.installed !== undefined, step);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !working && onClose()}>
      <DialogContent
        className="gap-5 p-5 sm:max-w-120"
        data-testid="add-dialog"
        data-step={step.name}
      >
        {step.name === 'choose' && (
          <>
            <DialogTitle className="text-lg font-semibold">{t('plugins.add.title')}</DialogTitle>
            <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-6">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full px-3"
                onClick={() => void choose('folder')}
                data-action="choose-folder"
              >
                <FolderPlus data-icon="inline-start" />
                {t('plugins.add.folder')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full px-3"
                onClick={() => void choose('file')}
                data-action="choose-file"
              >
                <FileArchive data-icon="inline-start" />
                {t('plugins.add.file')}
              </Button>
            </div>
            {error && <ErrorText>{error}</ErrorText>}
            <div className="flex justify-end">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        )}
        {step.name === 'working' && (
          <>
            <DialogTitle className="text-lg font-semibold">{t('plugins.add.title')}</DialogTitle>
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 py-2 pr-3 pl-3">
              <LoaderCircle
                aria-hidden
                className="size-4 shrink-0 animate-spin text-muted-foreground"
              />
              <span
                dir="rtl"
                title={step.path}
                className="min-w-0 flex-1 truncate text-left font-mono text-sm"
              >
                <bdi dir="ltr">{step.path}</bdi>
              </span>
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {t('plugins.add.working')}
            </p>
          </>
        )}
        {step.name === 'confirm' && (
          <>
            <DialogTitle className="text-lg font-semibold">
              {t(step.installed ? 'plugins.add.upgrade.title' : 'plugins.add.install.title', {
                name: step.preview.name,
              })}
            </DialogTitle>
            {step.installed && (
              <p className="font-mono text-sm text-muted-foreground">
                {t('plugins.add.upgrade.versions', {
                  from: `v${step.installed.version}`,
                  to: `v${step.preview.version}`,
                })}
              </p>
            )}
            <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
              <PluginHooks hooks={step.preview.hooks} />
              {step.preview.inputs.map((input) => (
                <InputField
                  key={input.key}
                  spec={{
                    key: input.key,
                    label: input.label,
                    description: input.description,
                    secret: input.secret === true,
                    required:
                      input.required === true &&
                      !step.installed?.inputs.some((old) => old.key === input.key && old.set),
                  }}
                  value={values[input.key] ?? ''}
                  onChange={(value) => {
                    setValues((current) => ({ ...current, [input.key]: value }));
                    setError(undefined);
                  }}
                />
              ))}
              {error && <ErrorText>{error}</ErrorText>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={missing.length > 0}
                  data-action={step.installed ? 'upgrade-plugin' : 'install-plugin'}
                >
                  {t(step.installed ? 'plugins.add.upgrade' : 'plugins.add.install')}
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ErrorText({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm break-words whitespace-pre-line text-destructive">
      {children}
    </p>
  );
}
