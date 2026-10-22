import {
  type Device,
  type DevicePlatform,
  formatPairingCode,
  PAIRING_WINDOW_MS,
  type PairingEndReason,
  type PairingOffer,
} from '@wevir/protocol';
import { cn } from 'cn';
import {
  Ban,
  CircleSlash,
  CircleX,
  Laptop,
  LoaderCircle,
  type LucideIcon,
  RotateCw,
  Smartphone,
  TimerOff,
} from 'lucide-react';
import { Fragment, useEffect, useReducer, useRef, useState } from 'react';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { formatCountdown, PLATFORM_LABEL, pairingDialogReducer } from './devices-model';

const ENDED_TEXT: Record<Exclude<PairingEndReason, 'paired'>, PlainMessageKey> = {
  denied: 'settings.pairing.denied',
  cancelled: 'settings.pairing.invalid',
  replaced: 'settings.pairing.invalid',
  expired: 'settings.pairing.expired',
  failed: 'settings.pairing.failed',
};

/**
 * “添加手机”弹窗（0.107.0）：打开时 `pairing.start`，显示二维码、短码与倒计时；手机握手完成后显示设备名与平台，用户允许或拒绝
 * （`pairing.respond`）。窗口到期、握手失败、被拒绝时停在结果上，可以重新生成；配对成功后关闭并把设备交给 `onClose`。
 * 关掉弹窗时结束这个窗口（`pairing.cancel`）。
 */
export function PairingDialog({ onClose }: { onClose: (paired?: Device) => void }) {
  const { client } = useHostConnection();
  const [state, dispatch] = useReducer(pairingDialogReducer, { phase: 'starting' });
  const [responding, setResponding] = useState(false);
  const [respondError, setRespondError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const pairingId = state.phase === 'open' ? state.offer.pairingId : undefined;
  const pairingIdRef = useRef(pairingId);
  pairingIdRef.current = pairingId;
  const paired = useRef<Device>(undefined);

  const start = () => {
    if (!client) return;
    dispatch({ type: 'start' });
    setRespondError(undefined);
    client.request('pairing.start', {}).then(
      (offer) => dispatch({ type: 'offer', offer }),
      (reason: unknown) =>
        dispatch({
          type: 'failed',
          error: t('settings.devices.failed', { error: describe(reason) }),
        }),
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时开一次窗口。
  useEffect(() => {
    start();
    // 关掉弹窗时结束还开着的窗口。
    return () => {
      const id = pairingIdRef.current;
      if (id !== undefined && client) void client.request('pairing.cancel', { pairingId: id });
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    return client.onRemoteDevicesChanged((change) => {
      if (change === undefined) dispatch({ type: 'reconnected' });
      else if (change.kind === 'pairing_request')
        dispatch({ type: 'request', request: change.request });
      else if (change.kind === 'pairing_ended') {
        dispatch({ type: 'ended', pairingId: change.ended.pairingId, reason: change.ended.reason });
      }
    });
  }, [client]);

  useEffect(() => {
    if (state.phase !== 'open') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  // 自己允许的：`pairing.ended` 先于 `pairing.respond` 的结果到，等结果到了带上设备再关。
  useEffect(() => {
    if (state.phase === 'paired' && !responding) onClose(paired.current);
  }, [state.phase, responding, onClose]);

  const respond = async (allow: boolean) => {
    if (!client || state.phase !== 'open' || !state.request) return;
    setResponding(true);
    setRespondError(undefined);
    try {
      const result = await client.request('pairing.respond', {
        requestId: state.request.requestId,
        allow,
      });
      paired.current = result.device;
    } catch (reason) {
      setRespondError(t('settings.devices.failed', { error: describe(reason) }));
    } finally {
      setResponding(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" data-pairing-dialog={state.phase}>
        <DialogHeader>
          <DialogTitle>{t('settings.devices.add')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center py-2">
          {state.phase === 'starting' && (
            <div className="flex size-[13.5rem] items-center justify-center rounded-2xl bg-muted/60 ring-1 ring-border">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              <span className="sr-only">{t('common.loading')}</span>
            </div>
          )}
          {state.phase === 'open' && !state.request && <OfferView offer={state.offer} now={now} />}
          {state.phase === 'open' && state.request && (
            <div
              className="flex flex-col items-center gap-4 py-8 text-center"
              data-pairing-request={state.request.requestId}
            >
              <div className="flex size-16 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
                <PlatformIcon platform={state.request.platform} className="size-7" />
              </div>
              <div>
                <div className="text-base font-medium">
                  {t('settings.pairing.request', { name: state.request.name })}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {t(PLATFORM_LABEL[state.request.platform])}
                </div>
              </div>
              {respondError && (
                <p role="alert" className="text-sm text-destructive">
                  {respondError}
                </p>
              )}
            </div>
          )}
          {state.phase === 'ended' && (
            <EndedView
              reason={state.reason}
              text={t(ENDED_TEXT[state.reason])}
              data-pairing-ended={state.reason}
            />
          )}
          {state.phase === 'error' && <EndedView reason="failed" text={state.error} />}
        </div>
        {((state.phase === 'open' && state.request) ||
          state.phase === 'ended' ||
          state.phase === 'error') && (
          <DialogFooter>
            {state.phase === 'open' && state.request ? (
              <>
                <Button
                  variant="outline"
                  disabled={responding}
                  onClick={() => void respond(false)}
                  data-action="deny-pairing"
                >
                  {t('settings.pairing.deny')}
                </Button>
                <Button
                  disabled={responding}
                  onClick={() => void respond(true)}
                  data-action="allow-pairing"
                >
                  {t('settings.pairing.allow')}
                </Button>
              </>
            ) : state.phase === 'ended' || state.phase === 'error' ? (
              <Button onClick={start} data-action="restart-pairing">
                <RotateCw data-icon="inline-start" />
                {t('settings.pairing.retry')}
              </Button>
            ) : null}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 二维码、分组的短码与倒计时条；剩 30 秒起倒计时转为警示色。 */
function OfferView({ offer, now }: { offer: PairingOffer; now: number }) {
  const left = Math.max(0, Date.parse(offer.expiresAt) - now);
  const urgent = left <= 30_000;
  const code = formatPairingCode(offer.shortCode);
  const groups = code.split('-');
  return (
    <div className="flex w-full flex-col items-center gap-5">
      <div className="rounded-2xl bg-muted/60 p-3 ring-1 ring-border">
        <QrCode
          value={offer.uri}
          label={t('settings.pairing.qr')}
          className="size-48 rounded-xl p-1.5 shadow-sm"
        />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="text-xs text-muted-foreground">{t('settings.pairing.code')}</div>
        <div
          className="flex items-center gap-2 font-mono text-lg font-semibold select-all"
          // 每个字一个格子，复制时 innerText 会按格子换行；改成复制 ABCD-EFGH。
          onCopy={(event) => {
            event.preventDefault();
            event.clipboardData.setData('text/plain', code);
          }}
          data-pairing-code
        >
          {groups.map((group, index) => (
            <Fragment key={group + String(index)}>
              {index > 0 && <span className="text-muted-foreground">-</span>}
              <span className="flex gap-1">
                {[...group].map((char, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: 位置即身份，字符可重复。
                    key={i}
                    className="flex h-9 w-7 items-center justify-center rounded-md bg-muted ring-1 ring-border"
                  >
                    {char}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
        </div>
      </div>
      <div className="flex w-40 flex-col items-center gap-1.5">
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-1000 ease-linear',
              urgent ? 'bg-warning' : 'bg-foreground/40',
            )}
            style={{ width: `${Math.min(100, (left / PAIRING_WINDOW_MS) * 100)}%` }}
          />
        </div>
        <div
          className={cn('text-xs tabular-nums', urgent ? 'text-warning' : 'text-muted-foreground')}
          data-pairing-countdown
        >
          {t('settings.pairing.expiresIn', { time: formatCountdown(left) })}
        </div>
      </div>
    </div>
  );
}

const ENDED_ICON: Record<Exclude<PairingEndReason, 'paired'>, LucideIcon> = {
  denied: Ban,
  cancelled: CircleSlash,
  replaced: CircleSlash,
  expired: TimerOff,
  failed: CircleX,
};

/** 窗口结束：图标与一行结果，握手失败用错误色。 */
function EndedView({
  reason,
  text,
  ...rest
}: {
  reason: Exclude<PairingEndReason, 'paired'>;
  text: string;
  'data-pairing-ended'?: string;
}) {
  const Icon = ENDED_ICON[reason];
  const failed = reason === 'failed';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="flex flex-col items-center gap-3 px-4 py-10 text-center"
      {...rest}
    >
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full',
          failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-6" />
      </div>
      <div className={cn('text-sm', failed ? 'text-destructive' : 'text-muted-foreground')}>
        {text}
      </div>
    </div>
  );
}

function PlatformIcon({ platform, className }: { platform: DevicePlatform; className?: string }) {
  const Icon = platform === 'ios' || platform === 'android' ? Smartphone : Laptop;
  return <Icon className={className} />;
}
