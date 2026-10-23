// “模拟器”窗格（0.122.0，desktop-layout.md §44，照 Claude Code 的模拟器窗格）：Host 声明 `ios_simulator` 时可用。顶栏是设备
// 选择（已启动 / 可用（将启动）/ 新增模拟器… / 断开 / 关机）、编辑、设备、显示三个菜单与四个缩放按钮；中间是带外框的设备画面
// （simulator-display.tsx）；底部浮着主屏幕、向右旋转、存储截图、录制视频、标注。快捷键只在窗格获得焦点时生效，⌘ 组合以外的
// 按键交给设备。agent attach 设备时（`simulator.show`）会话视图打开这个窗格（simulator/simulator-reveal.ts）。

import type { WevirClient } from '@wevir/client-sdk';
import type {
  SessionId,
  SimulatorDevice,
  SimulatorInput,
  SimulatorOrientation,
  SimulatorUdid,
} from '@wevir/protocol';
import { cn } from 'cn';
import {
  Camera,
  Check,
  ChevronDown,
  Circle,
  Expand,
  House,
  PenLine,
  RotateCw,
  Smartphone,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { reportActionFailure, reportActionSuccess } from '@/data/action-notices';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { formatShortcut, matchesShortcut, type Shortcut } from '@/lib/shortcuts';
import { platformApi } from '@/platform/platform';
import { attachDraftImage } from '@/session/composer';
import { FloatingBar, SimulatorAnnotator } from '@/simulator/simulator-annotator';
import { SimulatorDisplay, type SimulatorDisplayHandle } from '@/simulator/simulator-display';
import {
  type FeedStatus,
  haltFeed,
  type Recording,
  recordings,
  reloadCatalog,
  restartFeed,
  selectDevice,
  setDeviceToggles,
  setRecording,
  useDeviceToggles,
  useFeedStatus,
  useMacClipboard,
  useSelectedDevice,
  useSimulatorCatalog,
} from '@/simulator/simulator-feed';
import {
  bezelOf,
  captureFileName,
  defaultDevice,
  defaultNewDevice,
  deviceGroups,
  fitScale,
  formatDuration,
  pointsOf,
  SIMULATOR_SHORTCUTS,
  type Size,
  sideButtons,
  type Zoom,
  zoomIn,
  zoomOut,
} from '@/simulator/simulator-model';
import type { PaneContext } from '../pane-registry';
import { Note } from './files-pane';

/** 还没出画面时外框按这个点尺寸占位（iPhone 17 Pro / iPad Air 竖放）。 */
const PLACEHOLDER_POINTS: Record<'phone' | 'tablet', Size> = {
  phone: { width: 402, height: 874 },
  tablet: { width: 820, height: 1180 },
};
/** 画面四周与底部工具栏留出的空白（CSS 像素）。 */
const STAGE_PADDING = 24;
const TOOLBAR_SPACE = 52;
const LONG_REQUEST_MS = 120_000;

export function SimulatorPane({ context }: { context: PaneContext }) {
  const { client } = useHostConnection();
  if (!client?.supports('ios_simulator')) {
    return <Note icon={Smartphone}>{t('simulator.unsupported')}</Note>;
  }
  return <SimulatorView client={client} sessionId={context.sessionId as SessionId | undefined} />;
}

function SimulatorView({
  client,
  sessionId,
}: {
  client: WevirClient;
  sessionId: SessionId | undefined;
}) {
  const catalog = useSimulatorCatalog(client);
  const selected = useSelectedDevice(sessionId);
  const fallback =
    selected === undefined && catalog.status === 'ready'
      ? defaultDevice(catalog.devices, sessionId)
      : undefined;
  // 第一次打开时选中的默认设备记下来，之后别的设备启动也不跟着换。
  useEffect(() => {
    if (fallback) selectDevice(sessionId, fallback.udid);
  }, [fallback, sessionId]);
  const udid = selected ?? fallback?.udid ?? undefined;
  const device = catalog.devices.find((candidate) => candidate.udid === udid);
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="simulator-pane">
      {udid === undefined ? (
        <>
          <TopBar
            client={client}
            sessionId={sessionId}
            device={undefined}
            onAdd={() => setAdding(true)}
          />
          <div className="min-h-0 flex-1">
            <Note icon={Smartphone}>
              {catalog.status === 'failed'
                ? t('simulator.listFailed', { error: catalog.error ?? '' })
                : catalog.status === 'loading'
                  ? t('common.loading')
                  : t('simulator.noDevice')}
            </Note>
          </div>
        </>
      ) : (
        <DeviceStage
          key={udid}
          client={client}
          sessionId={sessionId}
          udid={udid}
          device={device}
          onAdd={() => setAdding(true)}
        />
      )}
      {adding && (
        <NewDeviceDialog client={client} sessionId={sessionId} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}

interface Annotation {
  dataUrl: string;
  width: number;
  height: number;
}

function DeviceStage({
  client,
  sessionId,
  udid,
  device,
  onAdd,
}: {
  client: WevirClient;
  sessionId: SessionId | undefined;
  udid: SimulatorUdid;
  device: SimulatorDevice | undefined;
  onAdd: () => void;
}) {
  const status = useFeedStatus(client, udid, sessionId);
  const displayRef = useRef<SimulatorDisplayHandle>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [pixels, setPixels] = useState<Size>();
  const [orientation, setOrientation] = useState<SimulatorOrientation>();
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [annotation, setAnnotation] = useState<Annotation>();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const recording = recordings.use().get(udid);
  const name = device?.name ?? udid;

  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setArea({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = status.kind === 'live' ? status.scale : undefined;
  const points =
    pixels && scale
      ? pointsOf(pixels, scale)
      : PLACEHOLDER_POINTS[device?.family === 'ipad' ? 'tablet' : 'phone'];
  const { bezel, radius } = bezelOf(device?.family);
  const fit = fitScale(
    {
      width: area.width - STAGE_PADDING * 2,
      height: area.height - STAGE_PADDING * 2 - TOOLBAR_SPACE,
    },
    points,
    bezel,
  );
  const factor = zoom.mode === 'fit' ? fit : zoom.scale;
  const setFixed = (next: number) => setZoom({ mode: 'fixed', scale: next });

  const send = (input: SimulatorInput) => {
    void client.request('simulator.input', { udid, input }).catch(() => {});
  };

  const saveScreenshot = async () => {
    try {
      const shot = await client.request('simulator.screenshot', {
        udid,
        format: 'png',
        ...(scale !== undefined && { scale }),
      });
      if (shot.data === undefined) return;
      await platformApi().saveImageAs(captureFileName(name, new Date(), 'png'), shot.data);
    } catch (error) {
      reportActionFailure(t('simulator.screenshotFailed', { error: describe(error) }));
    }
  };

  const toggleRecording = async () => {
    const current = recordings.get().get(udid);
    if (current?.stopping) return;
    if (!current) {
      try {
        const { recordingId } = await client.request('simulator.record.start', { udid });
        setRecording(udid, { recordingId, startedAt: Date.now() });
      } catch (error) {
        reportActionFailure(t('simulator.recordFailed', { error: describe(error) }));
      }
      return;
    }
    setRecording(udid, { ...current, stopping: true });
    try {
      const { path } = await client.request(
        'simulator.record.stop',
        { recordingId: current.recordingId },
        { timeoutMs: 70_000 },
      );
      setRecording(udid, undefined);
      await platformApi().saveFileAs(path, captureFileName(name, new Date(), 'mp4'));
    } catch (error) {
      setRecording(udid, undefined);
      reportActionFailure(t('simulator.recordFailed', { error: describe(error) }));
    }
  };

  const startAnnotation = async () => {
    try {
      const shot = await client.request('simulator.screenshot', {
        udid,
        format: 'png',
        scale: Math.min(scale ?? 2, 2),
      });
      if (shot.data === undefined) return;
      setAnnotation({
        dataUrl: `data:${shot.mimeType};base64,${shot.data}`,
        width: shot.width,
        height: shot.height,
      });
    } catch (error) {
      reportActionFailure(t('simulator.screenshotFailed', { error: describe(error) }));
    }
  };

  const finishAnnotation = async (dataUrl: string) => {
    if (sessionId === undefined) return;
    try {
      await attachDraftImage(sessionId, client, {
        dataUrl,
        mimeType: 'image/png',
        name: captureFileName(name, new Date(), 'png'),
      });
      setAnnotation(undefined);
      reportActionSuccess(t('simulator.annotate.attached'));
    } catch (error) {
      reportActionFailure(t('simulator.annotate.failed', { error: describe(error) }));
    }
  };

  const zoomActions: [Shortcut, () => void][] = [
    [SIMULATOR_SHORTCUTS.zoomIn, () => setFixed(zoomIn(factor))],
    [{ ...SIMULATOR_SHORTCUTS.zoomIn, shift: true }, () => setFixed(zoomIn(factor))],
    [SIMULATOR_SHORTCUTS.zoomOut, () => setFixed(zoomOut(factor))],
    [SIMULATOR_SHORTCUTS.fit, () => setZoom({ mode: 'fit' })],
    [SIMULATOR_SHORTCUTS.actualSize, () => setFixed(1)],
  ];
  const deviceActions: [Shortcut, () => void][] = [
    [SIMULATOR_SHORTCUTS.home, () => send({ type: 'button', name: 'HOME' })],
    [SIMULATOR_SHORTCUTS.rotateRight, () => send({ type: 'rotate', direction: 'right' })],
    [SIMULATOR_SHORTCUTS.rotateLeft, () => send({ type: 'rotate', direction: 'left' })],
    [SIMULATOR_SHORTCUTS.screenshot, () => void saveScreenshot()],
    [SIMULATOR_SHORTCUTS.record, () => void toggleRecording()],
  ];
  /** 编辑类的只在键盘落在设备上时转给设备，焦点在菜单按钮上时照常。 */
  const editActions: [Shortcut, () => void][] = [
    [SIMULATOR_SHORTCUTS.undo, () => send({ type: 'key', key: 'undo' })],
    [SIMULATOR_SHORTCUTS.redo, () => send({ type: 'key', key: 'redo' })],
    [SIMULATOR_SHORTCUTS.cut, () => send({ type: 'key', key: 'cut' })],
    [SIMULATOR_SHORTCUTS.copy, () => send({ type: 'key', key: 'copy' })],
    [SIMULATOR_SHORTCUTS.selectAll, () => send({ type: 'key', key: 'select_all' })],
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement) return;
    const onScreen = target.dataset.testid === 'simulator-keys';
    const actions = [
      ...zoomActions,
      ...(annotation ? [] : deviceActions),
      ...(onScreen && !annotation ? editActions : []),
    ];
    for (const [shortcut, action] of actions) {
      if (matchesShortcut(event, shortcut)) {
        event.preventDefault();
        action();
        return;
      }
    }
  };

  const display: Size = { width: points.width * factor, height: points.height * factor };
  const frameRadius = (radius + bezel) * factor;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 窗格里的快捷键；每一项都有菜单或按钮。
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <TopBar
        client={client}
        sessionId={sessionId}
        device={device ?? { udid, name }}
        onAdd={onAdd}
        display={displayRef}
        send={send}
        zoom={{
          in: () => setFixed(zoomIn(factor)),
          out: () => setFixed(zoomOut(factor)),
          fit: () => setZoom({ mode: 'fit' }),
          actual: () => setFixed(1),
        }}
      />
      <div className="relative min-h-0 flex-1">
        <div ref={areaRef} className="absolute inset-0 overflow-auto">
          <div
            className="flex min-h-full w-max min-w-full items-center justify-center"
            style={{ padding: STAGE_PADDING, paddingBottom: STAGE_PADDING + TOOLBAR_SPACE }}
          >
            <div
              className="relative shrink-0 bg-[#0c0c0d] shadow-lg ring-1 ring-foreground/15"
              style={{
                padding: bezel * factor,
                borderRadius: frameRadius,
                width: display.width + bezel * factor * 2,
                height: display.height + bezel * factor * 2,
              }}
              data-testid="simulator-frame"
              data-orientation={orientation}
            >
              {sideButtons(device?.family, orientation).map((button) => (
                <SideKey key={`${button.edge}${button.start}`} button={button} factor={factor} />
              ))}
              <div
                className={cn(
                  'relative transition-opacity duration-200',
                  (status.kind === 'shutdown' || status.kind === 'failed') && 'opacity-40',
                )}
                style={{ width: display.width, height: display.height }}
              >
                <SimulatorDisplay
                  handle={displayRef}
                  client={client}
                  udid={udid}
                  sessionId={sessionId}
                  points={pixels && scale ? points : undefined}
                  radius={radius * factor}
                  onPixels={(next, nextOrientation) => {
                    setPixels(next);
                    setOrientation(nextOrientation);
                  }}
                  send={send}
                />
                {/* 标注时画面流照常连着，回来不用重连。 */}
                {annotation && (
                  <div className="absolute inset-0">
                    <SimulatorAnnotator
                      image={annotation}
                      display={display}
                      radius={radius * factor}
                      toolbar={slot}
                      onCancel={() => setAnnotation(undefined)}
                      onDone={finishAnnotation}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        {!annotation && (
          <StatusOverlay
            status={status}
            device={device}
            onRetry={() => restartFeed(udid)}
            live={pixels !== undefined}
          />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          {annotation ? (
            <div ref={setSlot} className="contents" />
          ) : (
            <MainToolbar
              recording={recording}
              canAnnotate={sessionId !== undefined && status.kind === 'live'}
              disabled={status.kind !== 'live'}
              onHome={() => send({ type: 'button', name: 'HOME' })}
              onRotate={() => send({ type: 'rotate', direction: 'right' })}
              onScreenshot={() => void saveScreenshot()}
              onRecord={() => void toggleRecording()}
              onAnnotate={() => void startAnnotation()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SideKey({
  button,
  factor,
}: {
  button: ReturnType<typeof sideButtons>[number];
  factor: number;
}) {
  const thickness = Math.max(2, 3.5 * factor);
  const vertical = button.edge === 'left' || button.edge === 'right';
  return (
    <span
      aria-hidden
      className="absolute rounded-sm bg-[#2a2a2c]"
      style={{
        [button.edge]: -thickness,
        ...(vertical
          ? { top: `${button.start * 100}%`, height: `${button.length * 100}%`, width: thickness }
          : {
              left: `${button.start * 100}%`,
              width: `${button.length * 100}%`,
              height: thickness,
            }),
      }}
    />
  );
}

function StatusOverlay({
  status,
  device,
  live,
  onRetry,
}: {
  status: FeedStatus;
  device: SimulatorDevice | undefined;
  live: boolean;
  onRetry: () => void;
}) {
  let content: ReactNode;
  if (status.kind === 'shutdown') {
    content = (
      <>
        <span>{t('simulator.shutDown')}</span>
        <Button size="xs" variant="secondary" onClick={onRetry} data-testid="simulator-boot">
          {t('simulator.boot')}
        </Button>
      </>
    );
  } else if (status.kind === 'failed') {
    content = (
      <>
        <span className="max-w-64 truncate" title={status.error}>
          {status.error === '' ? t('simulator.failed') : status.error}
        </span>
        <Button size="xs" variant="secondary" onClick={onRetry}>
          {t('simulator.retry')}
        </Button>
      </>
    );
  } else if (status.kind === 'reconnecting') {
    content = <span>{t('simulator.reconnecting')}</span>;
  } else if (status.kind === 'connecting' || !live) {
    content = (
      <span>
        {device?.state === 'shutdown' ? t('simulator.booting') : t('simulator.connecting')}
      </span>
    );
  } else {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-popover/90 px-3 py-1.5 text-sm text-muted-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl"
        role="status"
        data-testid="simulator-status"
        data-status={status.kind}
      >
        {content}
      </div>
    </div>
  );
}

function MainToolbar({
  recording,
  canAnnotate,
  disabled,
  onHome,
  onRotate,
  onScreenshot,
  onRecord,
  onAnnotate,
}: {
  recording: Recording | undefined;
  canAnnotate: boolean;
  disabled: boolean;
  onHome: () => void;
  onRotate: () => void;
  onScreenshot: () => void;
  onRecord: () => void;
  onAnnotate: () => void;
}) {
  const button = 'rounded-full';
  return (
    <FloatingBar>
      <IconButton
        label={t('simulator.device.home')}
        shortcut={formatShortcut(SIMULATOR_SHORTCUTS.home)}
        tooltipSide="top"
        className={button}
        disabled={disabled}
        onClick={onHome}
        data-testid="simulator-home"
      >
        <House />
      </IconButton>
      <IconButton
        label={t('simulator.device.rotateRight')}
        shortcut={formatShortcut(SIMULATOR_SHORTCUTS.rotateRight)}
        tooltipSide="top"
        className={button}
        disabled={disabled}
        onClick={onRotate}
        data-testid="simulator-rotate"
      >
        <RotateCw />
      </IconButton>
      <IconButton
        label={t('simulator.screenshot')}
        shortcut={formatShortcut(SIMULATOR_SHORTCUTS.screenshot)}
        tooltipSide="top"
        className={button}
        disabled={disabled}
        onClick={onScreenshot}
        data-testid="simulator-screenshot"
      >
        <Camera />
      </IconButton>
      {recording ? (
        <RecordingButton recording={recording} onStop={onRecord} />
      ) : (
        <IconButton
          label={t('simulator.record')}
          shortcut={formatShortcut(SIMULATOR_SHORTCUTS.record)}
          tooltipSide="top"
          className={button}
          disabled={disabled}
          onClick={onRecord}
          data-testid="simulator-record"
        >
          <Circle />
        </IconButton>
      )}
      <IconButton
        label={t('simulator.annotate')}
        tooltipSide="top"
        className={button}
        disabled={!canAnnotate}
        onClick={onAnnotate}
        data-testid="simulator-annotate"
      >
        <PenLine />
      </IconButton>
    </FloatingBar>
  );
}

function RecordingButton({ recording, onStop }: { recording: Recording; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t('simulator.stopRecording')}
      title={`${t('simulator.stopRecording')} ${formatShortcut(SIMULATOR_SHORTCUTS.record)}`}
      disabled={recording.stopping}
      onClick={onStop}
      className="rounded-full font-mono text-destructive tabular-nums"
      data-testid="simulator-stop-recording"
    >
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-destructive" />
      {formatDuration(now - recording.startedAt)}
      <Square className="fill-current" />
    </Button>
  );
}

// ── 顶栏 ─────────────────────────────────────────────────────────────────

function TopBar({
  client,
  sessionId,
  device,
  onAdd,
  display,
  send,
  zoom,
}: {
  client: WevirClient;
  sessionId: SessionId | undefined;
  device: Pick<SimulatorDevice, 'udid' | 'name'> | undefined;
  onAdd: () => void;
  display?: React.RefObject<SimulatorDisplayHandle | null>;
  send?: (input: SimulatorInput) => void;
  zoom?: { in: () => void; out: () => void; fit: () => void; actual: () => void };
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
      <DevicePicker client={client} sessionId={sessionId} current={device} onAdd={onAdd} />
      {device && send && display && (
        <>
          <EditMenu client={client} udid={device.udid} display={display} send={send} />
          <DeviceMenu client={client} udid={device.udid} send={send} />
        </>
      )}
      {zoom && <ViewMenu zoom={zoom} />}
      <div className="min-w-1 flex-1" />
      {zoom && (
        <>
          <IconButton
            label={t('simulator.view.zoomOut')}
            shortcut={formatShortcut(SIMULATOR_SHORTCUTS.zoomOut)}
            size="icon-xs"
            tooltipSide="bottom"
            onClick={zoom.out}
          >
            <ZoomOut />
          </IconButton>
          <IconButton
            label={t('simulator.view.fit')}
            shortcut={formatShortcut(SIMULATOR_SHORTCUTS.fit)}
            size="icon-xs"
            tooltipSide="bottom"
            onClick={zoom.fit}
            data-testid="simulator-fit"
          >
            <Expand />
          </IconButton>
          <IconButton
            label={t('simulator.view.actualSize')}
            shortcut={formatShortcut(SIMULATOR_SHORTCUTS.actualSize)}
            size="icon-xs"
            tooltipSide="bottom"
            onClick={zoom.actual}
            data-testid="simulator-actual-size"
          >
            <span className="text-[11px] font-semibold">1:1</span>
          </IconButton>
          <IconButton
            label={t('simulator.view.zoomIn')}
            shortcut={formatShortcut(SIMULATOR_SHORTCUTS.zoomIn)}
            size="icon-xs"
            tooltipSide="bottom"
            onClick={zoom.in}
          >
            <ZoomIn />
          </IconButton>
        </>
      )}
    </div>
  );
}

function MenuTrigger({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <DropdownMenuTrigger
      render={<Button variant="ghost" size="xs" className="shrink-0" data-testid={testId} />}
    >
      {children}
    </DropdownMenuTrigger>
  );
}

function DevicePicker({
  client,
  sessionId,
  current,
  onAdd,
}: {
  client: WevirClient;
  sessionId: SessionId | undefined;
  current: Pick<SimulatorDevice, 'udid' | 'name'> | undefined;
  onAdd: () => void;
}) {
  const catalog = useSimulatorCatalog(client);
  const { booted, available } = deviceGroups(catalog.devices);
  const currentState = catalog.devices.find((device) => device.udid === current?.udid)?.state;
  const item = (device: SimulatorDevice) => (
    <DropdownMenuItem
      key={device.udid}
      onClick={() => selectDevice(sessionId, device.udid)}
      data-testid="simulator-device-option"
      data-udid={device.udid}
    >
      <span className="min-w-0 flex-1 truncate">{device.name}</span>
      <span className="text-xs text-muted-foreground">{device.osVersion}</span>
      <Check className={cn('size-4', device.udid !== current?.udid && 'invisible')} />
    </DropdownMenuItem>
  );
  const shutdown = () => {
    if (!current) return;
    haltFeed(current.udid);
    void client
      .request('simulator.shutdown', { udid: current.udid }, { timeoutMs: LONG_REQUEST_MS })
      .catch((error: unknown) =>
        reportActionFailure(t('simulator.actionFailed', { error: describe(error) })),
      );
  };
  return (
    <DropdownMenu onOpenChange={(open) => open && void reloadCatalog(client)}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 max-w-48 shrink"
            data-testid="simulator-device-picker"
          />
        }
      >
        <Smartphone />
        <span className="truncate">{current?.name ?? t('simulator.choose')}</span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        {booted.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('simulator.booted')}</DropdownMenuLabel>
            {booted.map(item)}
          </DropdownMenuGroup>
        )}
        {available.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('simulator.available')}</DropdownMenuLabel>
            {available.map(item)}
          </DropdownMenuGroup>
        )}
        {(booted.length > 0 || available.length > 0) && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onAdd} data-testid="simulator-add">
          {t('simulator.add')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!current}
          onClick={() => selectDevice(sessionId, null)}
          data-testid="simulator-detach"
        >
          {t('simulator.detach')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={currentState !== 'booted'}
          onClick={shutdown}
          data-testid="simulator-shutdown"
        >
          {t('simulator.shutdown')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShortcutItem({
  label,
  shortcut,
  onClick,
  testId,
}: {
  label: string;
  shortcut?: Shortcut;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <DropdownMenuItem onClick={onClick} data-testid={testId}>
      {label}
      {shortcut && <DropdownMenuShortcut>{formatShortcut(shortcut)}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}

function EditMenu({
  client,
  udid,
  display,
  send,
}: {
  client: WevirClient;
  udid: SimulatorUdid;
  display: React.RefObject<SimulatorDisplayHandle | null>;
  send: (input: SimulatorInput) => void;
}) {
  const macClipboard = useMacClipboard.use();
  const key = (name: Extract<SimulatorInput, { type: 'key' }>['key']) => () => {
    send({ type: 'key', key: name });
    display.current?.focus();
  };
  const paste = (mode: 'paste' | 'send') => {
    const handled = display.current?.pasteFromMac(mode) ?? false;
    if (handled) return;
    if (mode === 'paste') send({ type: 'key', key: 'paste' });
    else reportActionFailure(t('simulator.clipboardUnavailable'));
  };
  const getClipboard = async () => {
    try {
      const { text } = await client.request('simulator.clipboard.get', { udid });
      await platformApi().copyText(text);
      reportActionSuccess(t('simulator.edit.clipboardCopied'));
    } catch (error) {
      reportActionFailure(t('simulator.actionFailed', { error: describe(error) }));
    }
  };
  return (
    <DropdownMenu>
      <MenuTrigger testId="simulator-menu-edit">{t('simulator.menu.edit')}</MenuTrigger>
      <DropdownMenuContent className="w-60">
        <ShortcutItem
          label={t('simulator.edit.undo')}
          shortcut={SIMULATOR_SHORTCUTS.undo}
          onClick={key('undo')}
        />
        <ShortcutItem
          label={t('simulator.edit.redo')}
          shortcut={SIMULATOR_SHORTCUTS.redo}
          onClick={key('redo')}
        />
        <DropdownMenuSeparator />
        <ShortcutItem
          label={t('simulator.edit.cut')}
          shortcut={SIMULATOR_SHORTCUTS.cut}
          onClick={key('cut')}
        />
        <ShortcutItem
          label={t('simulator.edit.copy')}
          shortcut={SIMULATOR_SHORTCUTS.copy}
          onClick={key('copy')}
        />
        <ShortcutItem
          label={t('simulator.edit.paste')}
          shortcut={SIMULATOR_SHORTCUTS.paste}
          onClick={() => (macClipboard ? paste('paste') : key('paste')())}
        />
        <ShortcutItem label={t('simulator.edit.delete')} onClick={key('delete')} />
        <ShortcutItem
          label={t('simulator.edit.selectAll')}
          shortcut={SIMULATOR_SHORTCUTS.selectAll}
          onClick={key('select_all')}
        />
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          closeOnClick
          checked={macClipboard}
          onCheckedChange={(checked) => useMacClipboard.set(checked)}
          data-testid="simulator-mac-clipboard"
        >
          {t('simulator.edit.useMacClipboard')}
        </DropdownMenuCheckboxItem>
        <ShortcutItem
          label={t('simulator.edit.getClipboard')}
          onClick={() => void getClipboard()}
          testId="simulator-get-clipboard"
        />
        <ShortcutItem
          label={t('simulator.edit.sendClipboard')}
          onClick={() => paste('send')}
          testId="simulator-send-clipboard"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeviceMenu({
  client,
  udid,
  send,
}: {
  client: WevirClient;
  udid: SimulatorUdid;
  send: (input: SimulatorInput) => void;
}) {
  const toggles = useDeviceToggles(udid);
  const configure = (patch: {
    appearance?: 'light' | 'dark';
    statusBar?: 'live' | 'clean';
    slowAnimations?: boolean;
    hardwareKeyboard?: boolean;
    softwareKeyboard?: 'show' | 'hide';
  }) => {
    void client
      .request('simulator.configure', { udid, ...patch })
      .then(() => {
        const { softwareKeyboard: _, ...remembered } = patch;
        setDeviceToggles(udid, remembered);
      })
      .catch((error: unknown) =>
        reportActionFailure(t('simulator.actionFailed', { error: describe(error) })),
      );
  };
  return (
    <DropdownMenu>
      <MenuTrigger testId="simulator-menu-device">{t('simulator.menu.device')}</MenuTrigger>
      <DropdownMenuContent className="w-56">
        <ShortcutItem
          label={t('simulator.device.home')}
          shortcut={SIMULATOR_SHORTCUTS.home}
          onClick={() => send({ type: 'button', name: 'HOME' })}
        />
        <ShortcutItem
          label={t('simulator.device.lock')}
          onClick={() => send({ type: 'button', name: 'LOCK' })}
        />
        <ShortcutItem
          label={t('simulator.device.rotateLeft')}
          shortcut={SIMULATOR_SHORTCUTS.rotateLeft}
          onClick={() => send({ type: 'rotate', direction: 'left' })}
        />
        <ShortcutItem
          label={t('simulator.device.rotateRight')}
          shortcut={SIMULATOR_SHORTCUTS.rotateRight}
          onClick={() => send({ type: 'rotate', direction: 'right' })}
        />
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="simulator-appearance">
            {t('simulator.device.appearance')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={toggles.appearance ?? ''}
              onValueChange={(value) => configure({ appearance: value as 'light' | 'dark' })}
            >
              <DropdownMenuRadioItem
                closeOnClick
                value="light"
                data-testid="simulator-appearance-light"
              >
                {t('simulator.device.light')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                closeOnClick
                value="dark"
                data-testid="simulator-appearance-dark"
              >
                {t('simulator.device.dark')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t('simulator.device.keyboard')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuCheckboxItem
              closeOnClick
              checked={toggles.hardwareKeyboard ?? false}
              onCheckedChange={(checked) => configure({ hardwareKeyboard: checked })}
            >
              {t('simulator.device.hardwareKeyboard')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem onClick={() => configure({ softwareKeyboard: 'show' })}>
              {t('simulator.device.showKeyboard')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => configure({ softwareKeyboard: 'hide' })}>
              {t('simulator.device.hideKeyboard')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem
          closeOnClick
          checked={toggles.slowAnimations ?? false}
          onCheckedChange={(checked) => configure({ slowAnimations: checked })}
          data-testid="simulator-slow-animations"
        >
          {t('simulator.device.slowAnimations')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t('simulator.device.statusBar')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={toggles.statusBar ?? 'live'}
              onValueChange={(value) => configure({ statusBar: value as 'live' | 'clean' })}
            >
              <DropdownMenuRadioItem closeOnClick value="live">
                {t('simulator.device.statusLive')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem closeOnClick value="clean">
                {t('simulator.device.statusClean')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenu({
  zoom,
}: {
  zoom: { in: () => void; out: () => void; fit: () => void; actual: () => void };
}) {
  return (
    <DropdownMenu>
      <MenuTrigger testId="simulator-menu-view">{t('simulator.menu.view')}</MenuTrigger>
      <DropdownMenuContent className="w-52">
        <ShortcutItem
          label={t('simulator.view.zoomIn')}
          shortcut={SIMULATOR_SHORTCUTS.zoomIn}
          onClick={zoom.in}
        />
        <ShortcutItem
          label={t('simulator.view.zoomOut')}
          shortcut={SIMULATOR_SHORTCUTS.zoomOut}
          onClick={zoom.out}
        />
        <ShortcutItem
          label={t('simulator.view.fit')}
          shortcut={SIMULATOR_SHORTCUTS.fit}
          onClick={zoom.fit}
        />
        <ShortcutItem
          label={t('simulator.view.actualSize')}
          shortcut={SIMULATOR_SHORTCUTS.actualSize}
          onClick={zoom.actual}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── 新增模拟器 ───────────────────────────────────────────────────────────

function NewDeviceDialog({
  client,
  sessionId,
  onClose,
}: {
  client: WevirClient;
  sessionId: SessionId | undefined;
  onClose: () => void;
}) {
  const catalog = useSimulatorCatalog(client);
  const types = catalog.deviceTypes.filter(
    (type) => type.family === 'iphone' || type.family === 'ipad',
  );
  const runtimes = catalog.runtimes.filter(
    (runtime) => runtime.available && runtime.platform === 'ios',
  );
  const defaults = defaultNewDevice(types, runtimes);
  const [typeId, setTypeId] = useState(defaults?.deviceTypeId ?? '');
  const [runtimeId, setRuntimeId] = useState(defaults?.runtimeId ?? '');
  const [name, setName] = useState(defaults?.name ?? '');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { device } = await client.request(
        'simulator.create',
        { name: name.trim(), deviceTypeId: typeId, runtimeId },
        { timeoutMs: LONG_REQUEST_MS },
      );
      await reloadCatalog(client);
      selectDevice(sessionId, device.udid);
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="simulator-new-device">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('simulator.new.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
            <label htmlFor="simulator-new-name" className="text-sm text-muted-foreground">
              {t('simulator.new.name')}
            </label>
            <Input
              id="simulator-new-name"
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
              data-testid="simulator-new-name"
            />
            <span className="text-sm text-muted-foreground">{t('simulator.new.deviceType')}</span>
            <Select
              aria-label={t('simulator.new.deviceType')}
              value={typeId}
              onValueChange={(next) => {
                setTypeId(next);
                if (!nameEdited) setName(types.find((type) => type.id === next)?.name ?? '');
              }}
              options={types.map((type) => ({ value: type.id, label: type.name }))}
              data-testid="simulator-new-type"
            />
            <span className="text-sm text-muted-foreground">{t('simulator.new.runtime')}</span>
            <Select
              aria-label={t('simulator.new.runtime')}
              value={runtimeId}
              onValueChange={setRuntimeId}
              options={runtimes.map((runtime) => ({ value: runtime.id, label: runtime.name }))}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || name.trim() === '' || typeId === '' || runtimeId === ''}
              data-testid="simulator-new-create"
            >
              {t('simulator.new.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
