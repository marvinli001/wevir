import type { StatusTone } from '@/components/status-dot';
import { t } from '@/i18n';
import type { HostProcessStatus } from '../../../shared/desktop-api.js';
import type { HostConnectionView } from './host-connection';

/** 设置的“关于”里的连接状态：圆点与一句话。左栏不显示连接状态，断线时只有顶部提示。 */
export interface HostIndicator {
  tone: StatusTone;
  pulse?: boolean;
  text: string;
}

/**
 * 连上了就是“已连接”；断线时优先说明 Host 进程的情况（T5.5），与顶部提示一致：重新启动中、在等外部的 Host、
 * 起不来；否则是连接本身的状态。
 */
export function hostIndicator(
  view: HostConnectionView,
  host: HostProcessStatus | undefined,
): HostIndicator {
  if (view.status === 'connected') return { tone: 'success', text: t('host.connected') };
  switch (host?.phase) {
    case 'failed':
      return { tone: 'danger', text: t('host.hostFailed') };
    case 'restarting':
      return {
        tone: 'warning',
        pulse: true,
        text: t('host.restarting', { attempt: host.attempt, max: host.maxAttempts }),
      };
    case 'waiting':
      return { tone: 'warning', text: t('host.waiting') };
  }
  switch (view.status) {
    case 'connecting':
      return { tone: 'warning', pulse: true, text: t('host.connecting') };
    case 'reconnecting':
      return {
        tone: 'warning',
        pulse: true,
        text: t('host.reconnecting', { attempt: view.attempt }),
      };
    case 'closed':
      return { tone: 'neutral', text: t('host.closed') };
    case 'failed':
      return { tone: 'danger', text: t('host.failed') };
  }
}

/** 顶部连接提示（T5.5）的内容：断线、Host 重新启动、等外部 Host、起不来。连接正常时没有。 */
export interface ConnectionBanner {
  tone: 'warning' | 'danger';
  message: string;
  detail?: string;
  /** Host 起不来时的日志位置。 */
  logPath?: string;
  /** 主要操作：`reconnect` 立即重连，`retry` 重试（Host 起不来时让主进程重新拉起）。 */
  action?: 'reconnect' | 'retry';
}

/**
 * 按渲染进程到 Host 的连接状态与主进程看到的 Host 进程状态，决定顶部显示什么。连上了就不显示；首次连接中
 * 由页面自己显示“加载中”，只有 Host 起不来或正在重新启动时才提示。连接断了时优先说明 Host 进程的情况：在重新
 * 启动、在等外部的 Host 回来、还是已经放弃。
 */
export function connectionBanner(
  view: HostConnectionView,
  host: HostProcessStatus | undefined,
): ConnectionBanner | undefined {
  if (view.status === 'connected') return undefined;
  switch (host?.phase) {
    case 'failed':
      return {
        tone: 'danger',
        message: t('connection.hostFailed', { error: host.error }),
        logPath: host.logPath,
        action: 'retry',
      };
    case 'restarting':
      return {
        tone: 'warning',
        message: t('connection.restarting', { attempt: host.attempt, max: host.maxAttempts }),
        detail: host.reason,
      };
    case 'waiting':
      return {
        tone: 'warning',
        message: t('connection.waiting'),
        detail: t('connection.waitingHint'),
      };
    case 'starting':
      return view.status === 'connecting'
        ? undefined
        : { tone: 'warning', message: t('connection.starting') };
  }
  switch (view.status) {
    case 'connecting':
      return undefined;
    case 'reconnecting':
      return {
        tone: 'warning',
        message: t('connection.reconnecting', { attempt: view.attempt }),
        action: 'reconnect',
      };
    case 'failed':
      return {
        tone: 'danger',
        message: t('connection.failed', { error: view.error }),
        action: 'retry',
      };
    case 'closed':
      return {
        tone: 'danger',
        message:
          view.error === undefined
            ? t('connection.closedNoReason')
            : t('connection.closed', { error: view.error }),
        action: 'retry',
      };
  }
}
