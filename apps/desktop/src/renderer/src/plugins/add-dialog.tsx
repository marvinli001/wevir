// “添加”对话框（0.42.0，desktop-layout.md §23）：插件与 Skills 分段的“添加”，以及拖进页面的文件夹 / ZIP / SKILL.md。选来源、由主进程判断
// 内容、再按 add-flow.ts 的决定装 Skills、装插件包、先填输入项或问升级；失败就地显示在对话框里。

import type { Plugin, WevirPluginManifest } from '@wevir/protocol';
import { FileArchive, FolderPlus, LoaderCircle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import type { InstallSourceKind } from '../../../shared/desktop-api.js';
import {
  inputValues,
  isAlreadyInstalled,
  missingRequired,
  newlyInstalled,
  planAdd,
} from './add-flow';
import { InputField } from './plugin-inputs';
import { usePluginsContext } from './plugins-context';

/** 打开一次“添加”：`path` 是拖进来的（直接开始），没有就从选择开始；`id` 每次不同，换一次请求就重置对话框。 */
export interface AddRequest {
  id: number;
  path?: string;
  /** 打开时就要显示的错误（拖进了不止一项）。 */
  error?: string;
}

type Step =
  | { name: 'choose' }
  | { name: 'working'; path: string }
  | { name: 'inputs'; path: string; manifest: WevirPluginManifest }
  | { name: 'upgrade'; path: string; manifest?: WevirPluginManifest; installed?: Plugin };

export function AddDialog({
  request,
  packages,
  onClose,
}: {
  request: AddRequest | null;
  /** Host 有 `plugin_packages`（能装插件包）。 */
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

  // 拖进来的：一打开就判断并装。
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

  /** 判断来源是什么，再按 planAdd 的决定走下一步。 */
  const begin = async (path: string) => {
    setStep({ name: 'working', path });
    setError(undefined);
    try {
      const inspection = await platformApi().inspectInstallSource(path);
      const plan = planAdd(inspection, [...plugins.values()], packages);
      switch (plan.action) {
        case 'error':
          setStep({ name: 'choose' });
          setError(
            t(
              plan.reason === 'packages'
                ? 'plugins.add.packagesUnsupported'
                : 'plugins.add.unsupported',
            ),
          );
          return;
        case 'skill':
          await installSkill(path);
          return;
        case 'plugin':
          await installPlugin(path, {}, { name: 'choose' });
          return;
        case 'inputs':
          setValues({});
          setStep({ name: 'inputs', path, manifest: plan.manifest });
          return;
        case 'upgrade':
          setStep({
            name: 'upgrade',
            path,
            manifest: plan.manifest,
            installed: plan.installed,
          });
          return;
      }
    } catch (reason) {
      setStep({ name: 'choose' });
      setError(t('plugins.add.inspectFailed', { error: describe(reason) }));
    }
  };

  const installSkill = async (path: string) => {
    try {
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
    } catch (reason) {
      setStep({ name: 'choose' });
      setError(t('plugins.add.failed', { error: describe(reason) }));
    }
  };

  /** 失败时回到 `back`（输入项那一步保留填过的值）；同 id 已装而没带 replace 的转成问升级。 */
  const installPlugin = async (
    path: string,
    options: { inputs?: Record<string, string>; replace?: boolean },
    back: Step,
  ) => {
    setStep({ name: 'working', path });
    setError(undefined);
    try {
      const result = await client.request('plugin.install', {
        path,
        ...(options.inputs !== undefined &&
          Object.keys(options.inputs).length > 0 && { inputs: options.inputs }),
        ...(options.replace && { replace: true }),
      });
      await data.refresh();
      const ignored =
        result.ignored.length > 0
          ? t('plugins.add.ignored', { items: result.ignored.join(t('common.listSeparator')) })
          : '';
      const main = options.replace
        ? t('plugins.add.upgraded', {
            name: result.plugin.name,
            version: `v${result.plugin.version}`,
          })
        : t('plugins.add.installed', { name: result.plugin.name });
      notify({ tone: 'success', text: main + ignored });
      onClose();
    } catch (reason) {
      if (!options.replace && isAlreadyInstalled(reason)) {
        setStep({ name: 'upgrade', path });
        return;
      }
      setStep(back);
      setError(t('plugins.add.failed', { error: describe(reason) }));
    }
  };

  const submitInputs = (event: FormEvent) => {
    event.preventDefault();
    if (step.name !== 'inputs' || missingRequired(step.manifest, values).length > 0) return;
    void installPlugin(step.path, { inputs: inputValues(values) }, step);
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
        {step.name === 'inputs' && (
          <>
            <DialogTitle className="text-lg font-semibold">
              {t('plugins.add.install.title', { name: step.manifest.name })}
            </DialogTitle>
            <form onSubmit={submitInputs} className="flex min-w-0 flex-col gap-4">
              {(step.manifest.inputs ?? []).map((input) => (
                <InputField
                  key={input.key}
                  spec={{
                    key: input.key,
                    label: input.label,
                    description: input.description,
                    secret: input.secret === true,
                    required: input.required === true,
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
                  disabled={missingRequired(step.manifest, values).length > 0}
                  data-action="install-plugin"
                >
                  {t('plugins.add.install')}
                </Button>
              </div>
            </form>
          </>
        )}
        {step.name === 'upgrade' && (
          <>
            <DialogTitle className="text-lg font-semibold">
              {step.manifest
                ? t('plugins.add.upgrade.title', { name: step.manifest.name })
                : t('plugins.add.upgrade.generic')}
            </DialogTitle>
            {step.manifest && step.installed && (
              <p className="font-mono text-sm text-muted-foreground">
                {t('plugins.add.upgrade.versions', {
                  from: `v${step.installed.version}`,
                  to: `v${step.manifest.version}`,
                })}
              </p>
            )}
            {error && <ErrorText>{error}</ErrorText>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => void installPlugin(step.path, { replace: true }, step)}
                data-action="upgrade-plugin"
              >
                {t('plugins.add.upgrade')}
              </Button>
            </div>
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
