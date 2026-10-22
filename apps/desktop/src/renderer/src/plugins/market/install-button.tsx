// 市场条目的安装按钮（0.99.0，plugin-market.md §9.1–§9.2）：没装时是“安装插件”（详情页）或“+”（列表行），点了变成 App Store 式的
// 圆环——等待与发布时一段弧转圈，下载时按字节从 12 点顺时针填满，中间的小方块点了停止；装好后详情页是灰的“已安装”，列表行是
// 一个勾。有必填输入项时先弹输入项对话框。状态在 market-install.ts，列表与详情共用。插件带 OAuth 连接器的（0.97.0），装好后
// 直接开始登录（打开浏览器）；还没登录时详情页的主按钮是“登录”。

import type { Connector, MarketEntry } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, Plus } from 'lucide-react';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import type { Notice } from '@/settings/settings-ui';
import { inputValues, missingRequired } from '../add-flow';
import { InputField } from '../plugin-inputs';
import {
  type InstallState,
  installFraction,
  marketInstalls,
  useInstallState,
} from './market-install';
import { entryText, OFFICIAL_SOURCE } from './market-model';
import type { MarketSource } from './use-market';

export interface MarketInstallContextValue {
  source: MarketSource | undefined;
  /** 已安装的插件 id。 */
  installed: ReadonlySet<string>;
  /** 装好之后重读插件列表；读完圆环才变成“已安装”。 */
  afterInstall(): Promise<void>;
  /** 已装插件里要登录或正在登录的 OAuth 连接器，按插件 id。 */
  signIns: ReadonlyMap<string, Connector>;
  /** 开始登录（打开浏览器）；失败时出通知。 */
  signIn(connector: Connector): void;
  /** 刚装好的插件有要登录的连接器时开始登录。 */
  signInAfterInstall(pluginId: string): void;
  /** 卸载插件；失败原样抛出。 */
  uninstall(pluginId: string): Promise<void>;
  notify(notice: Notice | undefined): void;
}

export const MarketInstallContext = createContext<MarketInstallContextValue | undefined>(undefined);

export function useMarketInstallContext(): MarketInstallContextValue {
  const value = useContext(MarketInstallContext);
  if (!value) throw new Error('useMarketInstallContext 必须在插件页之内使用');
  return value;
}

export function MarketInstallButton({
  entry,
  variant,
}: {
  entry: MarketEntry;
  variant: 'detail' | 'row';
}) {
  const { source, installed, afterInstall, signIns, signIn, signInAfterInstall, notify } =
    useMarketInstallContext();
  const navigate = useNavigate();
  const state = useInstallState(source, entry.id);
  const isInstalled = installed.has(entry.id);
  const [asking, setAsking] = useState(false);
  // 刚从圆环变成“已安装”时才播入场动画，打开页面时已经装好的不播。
  const wasInstalling = useRef(false);
  const justInstalled = isInstalled && state === undefined && wasInstalling.current;
  useEffect(() => {
    wasInstalling.current = state !== undefined;
  }, [state]);

  const name = entryText(entry, currentLocale()).name;
  const supported = source?.install !== undefined;

  const install = (inputs?: Record<string, string>) => {
    if (source === undefined) return;
    notify(undefined);
    marketInstalls(source)
      .start(entry.id, inputs, afterInstall)
      .then(
        (outcome) => {
          if (outcome.status !== 'installed') return;
          const { result } = outcome;
          const ignored =
            result.ignored.length > 0
              ? t('plugins.add.ignored', { items: result.ignored.join(t('common.listSeparator')) })
              : '';
          notify({
            tone: 'success',
            text: t('plugins.add.installed', { name: result.plugin.name }) + ignored,
          });
          signInAfterInstall(result.plugin.id);
        },
        (reason: unknown) =>
          notify({
            tone: 'error',
            text: t('plugins.market.installFailed', { error: describe(reason) }),
          }),
      );
  };
  const begin = () => {
    if (entry.contents.inputs.some((input) => input.required === true)) setAsking(true);
    else install();
  };

  let control: ReactNode;
  if (state !== undefined) {
    control = (
      <InstallRing
        state={state}
        name={name}
        size={variant === 'detail' ? 'md' : 'sm'}
        onStop={() => source && marketInstalls(source).cancel(entry.id)}
      />
    );
  } else if (isInstalled && variant === 'detail' && signIns.has(entry.id)) {
    const connector = signIns.get(entry.id) as Connector;
    const signingIn = connector.oauth?.status === 'signing_in';
    control = (
      <Button
        disabled={signingIn}
        onClick={() => signIn(connector)}
        data-action={signingIn ? 'signing-in' : 'sign-in'}
      >
        {t(signingIn ? 'plugins.connector.state.signingIn' : 'plugins.connector.signIn')}
      </Button>
    );
  } else if (isInstalled) {
    control =
      variant === 'detail' ? (
        <Button
          variant="secondary"
          disabled
          className={cn(justInstalled && 'animate-in fade-in zoom-in-90 duration-200')}
          data-action="installed"
        >
          {t('plugins.market.installed')}
        </Button>
      ) : (
        <IconButton
          label={t('plugins.market.installed')}
          className="relative z-10 text-muted-foreground"
          onClick={() => navigate(paths.marketEntry(OFFICIAL_SOURCE, entry.id))}
          data-action="installed"
        >
          <Check className={cn(justInstalled && 'confirm-pop')} />
        </IconButton>
      );
  } else if (variant === 'detail') {
    control = (
      <Button disabled={!supported} onClick={begin} data-action="install">
        {t('plugins.market.installPlugin')}
      </Button>
    );
  } else {
    // Host 装不了市场条目时“+”进详情页。
    control = (
      <IconButton
        label={t('plugins.market.install')}
        className="relative z-10"
        onClick={() =>
          supported ? begin() : navigate(paths.marketEntry(OFFICIAL_SOURCE, entry.id))
        }
        data-action="install"
      >
        <Plus />
      </IconButton>
    );
  }

  return (
    <>
      {control}
      {asking && (
        <InputsDialog
          entry={entry}
          name={name}
          onClose={() => setAsking(false)}
          onSubmit={(values) => {
            setAsking(false);
            install(values);
          }}
        />
      )}
    </>
  );
}

const RING_SIZES = {
  md: { button: 'icon', ring: 'size-7' },
  sm: { button: 'icon-sm', ring: 'size-6' },
} as const;

/**
 * 圆环：底下一圈浅轨道，上面是进度弧；不定进度时一段弧转圈。整个是“停止安装”按钮，中间一个小方块。
 * 弧从 12 点开始（整体转 -90°），`pathLength` 记成 100，`stroke-dashoffset` 就是没完成的百分比。
 */
function InstallRing({
  state,
  name,
  size,
  onStop,
}: {
  state: InstallState;
  name: string;
  size: keyof typeof RING_SIZES;
  onStop: () => void;
}) {
  const fraction = installFraction(state);
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  return (
    <IconButton
      label={t('plugins.market.stopInstall')}
      size={RING_SIZES[size].button}
      className="relative z-10 rounded-full text-primary hover:bg-muted/60 animate-in fade-in zoom-in-50 duration-200"
      onClick={onStop}
      data-action="stop-install"
      data-phase={state.phase}
    >
      <span
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={cn('relative grid place-items-center', RING_SIZES[size].ring)}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className={cn(
            'absolute inset-0 size-full -rotate-90',
            fraction === undefined && 'animate-spin [animation-duration:900ms]',
          )}
        >
          <circle
            cx="12"
            cy="12"
            r="10.5"
            fill="none"
            strokeWidth="2"
            className="stroke-current opacity-20"
          />
          <circle
            cx="12"
            cy="12"
            r="10.5"
            fill="none"
            strokeWidth="2"
            pathLength={100}
            strokeLinecap={fraction === undefined ? 'round' : 'butt'}
            strokeDasharray={fraction === undefined ? '26 74' : '100 100'}
            strokeDashoffset={fraction === undefined ? 0 : 100 - (percent ?? 0)}
            className="stroke-current transition-[stroke-dashoffset] duration-200 ease-out"
          />
        </svg>
        <span aria-hidden className="size-[30%] rounded-xs bg-current" />
      </span>
    </IconButton>
  );
}

/** 装之前先填输入项（只在有必填项时弹出）。 */
function InputsDialog({
  entry,
  name,
  onClose,
  onSubmit,
}: {
  entry: MarketEntry;
  name: string;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const inputs = entry.contents.inputs;
  const missing = missingRequired({ inputs }, values).length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!missing) onSubmit(inputValues(values));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-5 p-5 sm:max-w-120" data-testid="market-inputs-dialog">
        <DialogTitle className="text-lg font-semibold">
          {t('plugins.add.install.title', { name })}
        </DialogTitle>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          {inputs.map((input) => (
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
              onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
            />
          ))}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={missing} data-action="install-plugin">
              {t('plugins.add.install')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
