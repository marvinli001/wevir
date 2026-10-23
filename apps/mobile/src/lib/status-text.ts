// 电脑的状态在界面上怎么说：一行状态（列表与详情的标题下）与详情页的说明。纯逻辑。

import { type MessageKey, t, timeAgo } from '../i18n';
import type { LinkSnapshot, LinkStatus } from './computer-link';
import type { PairingFailure } from './pairing';

export type StatusTone = 'online' | 'pending' | 'offline' | 'problem';

export interface StatusLine {
  tone: StatusTone;
  text: string;
  /** 在线时：直连还是经中继。 */
  route?: string;
}

export function statusLine(
  snapshot: Pick<LinkSnapshot, 'status' | 'lastOnlineAt'>,
  now: Date,
): StatusLine {
  const { status } = snapshot;
  switch (status.kind) {
    case 'online':
      return {
        tone: 'online',
        text: t('status.online'),
        route: t(status.route === 'relay' ? 'route.relay' : 'route.direct'),
      };
    case 'paused':
      return { tone: 'pending', text: t('status.paused') };
    case 'connecting':
      return { tone: 'pending', text: t('status.connecting') };
    case 'removed':
      return { tone: 'problem', text: t('status.removed') };
    case 'offline':
      if (status.reason === 'remote_disabled')
        return { tone: 'offline', text: t('status.remoteDisabled') };
      if (status.reason === 'host_mismatch')
        return { tone: 'problem', text: t('status.hostMismatch') };
      return {
        tone: 'offline',
        text:
          snapshot.lastOnlineAt === undefined
            ? t('status.offline')
            : t('status.offlineSince', { time: timeAgo(snapshot.lastOnlineAt, now) }),
      };
  }
}

/** 详情页状态下方的说明；在线、连接中时没有。 */
export function statusNotice(status: LinkStatus): MessageKey | undefined {
  switch (status.kind) {
    case 'removed':
      return 'computer.removed';
    case 'offline':
      switch (status.reason) {
        case 'remote_disabled':
          return 'computer.remoteDisabled';
        case 'host_mismatch':
          return 'computer.hostMismatch';
        case 'relay':
          return 'computer.relay';
        case 'unreachable':
          return 'computer.unreachable';
      }
      return undefined;
    default:
      return undefined;
  }
}

export function pairingFailureText(failure: PairingFailure): string {
  switch (failure.kind) {
    case 'none_found':
      return t('pair.error.noneFound');
    case 'denied':
      return t('pair.error.denied');
    case 'wrong_secret':
      return t('pair.error.wrongSecret');
    case 'host_mismatch':
      return t('pair.error.hostMismatch');
    case 'window_closed':
      return t('pair.error.windowClosed');
    case 'unreachable':
      return t('pair.error.unreachable');
    case 'relay':
      return t('pair.error.relay');
    case 'timeout':
      return t('pair.error.timeout');
    case 'failed':
      return t('pair.error.failed');
  }
}
