import { cn } from 'cn';
import { AppWindow, Link2, Smartphone } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { type PlainMessageKey, t } from '@/i18n';
import type { remoteAccessState } from './devices-model';

type AccessState = ReturnType<typeof remoteAccessState>;

const STATE_LABEL: Record<Exclude<AccessState, 'connected'>, PlainMessageKey> = {
  off: 'settings.devices.scope',
  enabled: 'settings.devices.on',
  loading: 'common.loading',
  connecting: 'settings.devices.relayConnecting',
  ready: 'settings.devices.ready',
  noRoute: 'settings.devices.noRoute',
};

export function RemoteAccessCard({
  state,
  connections,
  saving,
  onEnable,
  onPhone,
  onWeb,
}: {
  state: AccessState;
  connections: number;
  saving: boolean;
  onEnable: (enabled: boolean) => void;
  onPhone: () => void;
  onWeb?: () => void;
}) {
  const enabled = state !== 'off';
  const ready = state === 'ready' || state === 'connected';
  return (
    <section
      aria-labelledby="remote-access-title"
      className="@container relative isolate mb-7 overflow-hidden rounded-xl border border-border bg-card"
      data-devices-remote
      data-setting="remote-enabled"
    >
      <div className="relative z-10 flex min-h-40 flex-col items-start justify-center gap-4 p-5 @min-[24rem]:pr-34 @min-[30rem]:py-6 @min-[30rem]:pr-48 @min-[30rem]:pl-6">
        <div>
          <div className="flex items-center gap-3">
            <h2 id="remote-access-title" className="text-lg font-semibold tracking-tight">
              {t('settings.devices.remote')}
            </h2>
            {enabled && (
              <Switch
                label={t('settings.devices.remote')}
                checked
                disabled={saving}
                onChange={onEnable}
              />
            )}
          </div>
          <p role="status" className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
            {enabled && (
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  ready ? 'bg-success' : state === 'noRoute' ? 'bg-warning' : 'bg-muted-foreground',
                )}
              />
            )}
            {state === 'connected'
              ? t('settings.devices.connections', { count: connections })
              : t(STATE_LABEL[state])}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {enabled ? (
            <>
              <Button onClick={onPhone} disabled={saving} data-action="add-device">
                <Smartphone data-icon="inline-start" />
                {t('settings.devices.add')}
              </Button>
              {onWeb && (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={onWeb}
                  data-action="add-web-device"
                >
                  <AppWindow data-icon="inline-start" />
                  {t('settings.devices.addWeb')}
                </Button>
              )}
            </>
          ) : (
            <Button disabled={saving} onClick={() => onEnable(true)} data-action="enable-remote">
              {t('settings.devices.enable')}
            </Button>
          )}
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-32 items-center justify-center @min-[24rem]:flex @min-[30rem]:w-46"
      >
        <div className="absolute inset-0 [background-image:radial-gradient(var(--border-strong)_0.8px,transparent_0.8px)] bg-size-[9px_9px] [mask-image:radial-gradient(ellipse_at_center,black_12%,transparent_72%)]" />
        <div className="relative h-24 w-34 shrink-0 scale-75 text-muted-foreground @min-[30rem]:scale-100">
          <div className="absolute top-1 left-0 flex h-17 w-27 items-center justify-center rounded-lg border border-foreground/30 bg-background p-1 shadow-sm">
            <div className="flex size-full items-center justify-center rounded-sm border border-border bg-brand/6">
              <BrandMark className="size-7 text-brand" />
            </div>
          </div>
          <div className="absolute top-18 left-12 h-2.5 w-2.5 border-x border-foreground/30 bg-muted" />
          <div className="absolute top-20.5 left-8 h-1 w-10 rounded-full border border-foreground/30 bg-card" />
          <div className="absolute right-1 bottom-0 flex h-15 w-8 items-center justify-center rounded-lg border border-foreground/35 bg-card shadow-sm">
            <span className="absolute top-1 h-0.5 w-2 rounded-full bg-foreground/25" />
            <Link2 className={cn('size-3.5', ready && 'text-success')} />
            <span className="absolute bottom-1 h-0.5 w-2.5 rounded-full bg-foreground/25" />
          </div>
        </div>
      </div>
    </section>
  );
}
