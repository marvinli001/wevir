// agent 的提醒（0.142.0）：`wevir_notify`。会话里的 agent 给用户发一条短提醒，走已有的通知意图（notifications.ts，种类 `agent`）：
// 电脑前没人时 PushService 加密后经推送网关发到开了推送的手机，开着的 Wevir（桌面与手机 App）照自己的显示偏好提醒。结果里说
// 实际发到了哪里。种类开关（Host 设置 `notifications.agent`）关着时不发；每个会话限频；像密钥的内容拒绝，不打码后照发。
// 只是提醒，不改文件、不碰别的会话，不用批准。归在工具预设的 `workbench` 组，按需加载。

import {
  AGENT_NOTIFICATION_BODY_MAX_LENGTH,
  AGENT_NOTIFICATION_TITLE_MAX_LENGTH,
  type NotificationIntent,
  type SessionId,
} from '@wevir/protocol';
import { type AppTool, AppToolError, jsonResult } from './app-mcp.js';
import type { AgentIntentRefusal } from './notifications.js';
import type { PushRecipients } from './remote/push.js';
import { looksLikeSecret } from './secret-patterns.js';

export const NOTIFY_TOOL = 'wevir_notify';
/** 同一个会话两条提醒至少隔多久。 */
export const NOTIFY_MIN_INTERVAL_MS = 60_000;
/** 同一个会话每小时最多几条。 */
export const NOTIFY_MAX_PER_HOUR = 6;
const HOUR_MS = 60 * 60_000;

export interface NotifyToolOptions {
  notifications: {
    /** 按种类开关与会话判定，得到要发的意图（还没发）。 */
    agentIntent(
      sessionId: SessionId,
      message: { title?: string; body: string },
    ): NotificationIntent | AgentIntentRefusal;
    /** 发给全部监听者，返回收下它的客户端连接数。 */
    publish(intent: NotificationIntent): number;
  };
  /** 推送（有远程访问时）：这条意图会推到几台设备，没有时为什么。 */
  push?: { recipients(intent: NotificationIntent): PushRecipients };
  now?: () => number;
  minIntervalMs?: number;
  maxPerHour?: number;
}

/** 折成一行、去掉首尾空白。 */
export function notificationLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 整理 agent 给的标题与正文：折成一行；空的正文、超长的、像密钥的拒绝（不截断、不打码，让模型改了再发）。标题可省略（用会话标题）。
 */
export function shapeAgentNotification(args: { title?: unknown; body?: unknown }): {
  title?: string;
  body: string;
} {
  if (args.body !== undefined && typeof args.body !== 'string') {
    throw new AppToolError('body must be a string.');
  }
  if (args.title !== undefined && typeof args.title !== 'string') {
    throw new AppToolError('title must be a string.');
  }
  const body = notificationLine(args.body ?? '');
  const title = args.title === undefined ? '' : notificationLine(args.title);
  if (body === '') throw new AppToolError('body must not be empty.');
  if (body.length > AGENT_NOTIFICATION_BODY_MAX_LENGTH) {
    throw new AppToolError(
      `body must be one short line of at most ${AGENT_NOTIFICATION_BODY_MAX_LENGTH} characters; say what the user needs to know or do and leave details for the conversation.`,
    );
  }
  if (title.length > AGENT_NOTIFICATION_TITLE_MAX_LENGTH) {
    throw new AppToolError(
      `title must be a short phrase of at most ${AGENT_NOTIFICATION_TITLE_MAX_LENGTH} characters.`,
    );
  }
  if (looksLikeSecret(body) || looksLikeSecret(title)) {
    throw new AppToolError(
      'The notification looks like it contains a secret (a key or token). Leave it out; notifications must never carry secrets.',
    );
  }
  return { ...(title !== '' && { title }), body };
}

/** 每个会话的限频：两条至少隔 `minIntervalMs`，一小时最多 `maxPerHour` 条。只记真正发出去的。 */
export class NotifyRateLimiter {
  readonly #minIntervalMs: number;
  readonly #maxPerHour: number;
  readonly #sent = new Map<SessionId, number[]>();

  constructor(options: { minIntervalMs?: number; maxPerHour?: number } = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? NOTIFY_MIN_INTERVAL_MS;
    this.#maxPerHour = options.maxPerHour ?? NOTIFY_MAX_PER_HOUR;
  }

  /** 现在能不能发；不能时还要等多少毫秒。 */
  check(sessionId: SessionId, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const sent = this.#recent(sessionId, now);
    const last = sent.at(-1);
    if (last !== undefined && now - last < this.#minIntervalMs) {
      return { ok: false, retryAfterMs: last + this.#minIntervalMs - now };
    }
    const oldest = sent[0];
    if (oldest !== undefined && sent.length >= this.#maxPerHour) {
      return { ok: false, retryAfterMs: oldest + HOUR_MS - now };
    }
    return { ok: true };
  }

  record(sessionId: SessionId, now: number): void {
    const sent = this.#recent(sessionId, now);
    sent.push(now);
    this.#sent.set(sessionId, sent);
  }

  #recent(sessionId: SessionId, now: number): number[] {
    const sent = (this.#sent.get(sessionId) ?? []).filter((at) => now - at < HOUR_MS);
    if (sent.length === 0) this.#sent.delete(sessionId);
    else this.#sent.set(sessionId, sent);
    return sent;
  }
}

/** 没推到手机的原因给模型看的说法。 */
const PUSH_SKIPPED: Record<NonNullable<PushRecipients['skipped']>, string> = {
  off: 'push to phones is off on this computer',
  no_device: 'no paired phone has push turned on',
  at_computer: 'the user is at the computer',
  rate_limited: "the phones' hourly push limit is reached",
};

export function notifyTools(options: NotifyToolOptions): AppTool[] {
  const now = options.now ?? Date.now;
  const limiter = new NotifyRateLimiter({
    ...(options.minIntervalMs !== undefined && { minIntervalMs: options.minIntervalMs }),
    ...(options.maxPerHour !== undefined && { maxPerHour: options.maxPerHour }),
  });
  return [
    {
      name: NOTIFY_TOOL,
      title: 'Notify the user',
      description:
        'Send the user a short notification: pushed to their paired phones when they are away from the computer, otherwise shown by the Wevir app. Only for what they must act on (a decision you are blocked on, a failure that needs them) or would want to know while away (a long job they wait for finished); not for progress or anything your answer already says. Never include secrets. body: one line; title (optional) replaces the session title. At most one a minute and six an hour per session. The result says where it went; if it was not delivered, do not retry. ' +
        `Max characters: title ${AGENT_NOTIFICATION_TITLE_MAX_LENGTH}, body ${AGENT_NOTIFICATION_BODY_MAX_LENGTH}.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: AGENT_NOTIFICATION_TITLE_MAX_LENGTH },
          body: { type: 'string', minLength: 1, maxLength: AGENT_NOTIFICATION_BODY_MAX_LENGTH },
        },
        required: ['body'],
        additionalProperties: false,
      },
      // 只提醒用户，不改文件、不碰别的会话、不往别处发内容：不用批准（Codex 看注解，Claude 与 OpenCode 看 `APP_TOOLS_NO_APPROVAL`）。
      // 不标只读，只读的角色（探索、评审……）没有它，由开它的会话决定要不要提醒。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      call: async (args, { sessionId }) => {
        const message = shapeAgentNotification(args);
        const at = now();
        const allowed = limiter.check(sessionId, at);
        if (!allowed.ok) {
          throw new AppToolError(
            `Too many notifications from this session: wait ${Math.ceil(allowed.retryAfterMs / 1000)} s (at most one a minute and ${NOTIFY_MAX_PER_HOUR} an hour). Put the update in your answer instead.`,
          );
        }
        const intent = options.notifications.agentIntent(sessionId, message);
        if ('refused' in intent) {
          switch (intent.refused) {
            case 'session':
              throw new AppToolError('This Wevir session no longer exists.');
            case 'nested':
              throw new AppToolError(
                'Only top-level sessions notify the user. Report to the session that opened you; it decides whether to notify.',
              );
            case 'off':
              return jsonResult({
                delivered: 'none',
                reason: 'The user turned off agent notifications in Wevir settings. Do not retry.',
              });
          }
        }
        const push = options.push?.recipients(intent) ?? { devices: 0, skipped: 'off' as const };
        const apps = options.notifications.publish(intent);
        limiter.record(sessionId, at);
        const notPushed =
          push.skipped === undefined ? undefined : `Not pushed: ${PUSH_SKIPPED[push.skipped]}.`;
        if (push.devices > 0) {
          return jsonResult({
            delivered: 'phone',
            phones: push.devices,
            apps,
            note: `Sent to the push service for ${push.devices === 1 ? '1 phone' : `${push.devices} phones`}${apps > 0 ? ' and shown by the open Wevir app' : ''}.`,
          });
        }
        if (apps > 0) {
          return jsonResult({
            delivered: 'app',
            phones: 0,
            apps,
            note: `Shown by the open Wevir app (a system notification when its window is in the background, nothing while the user is looking at this session). ${notPushed}`,
          });
        }
        return jsonResult({
          delivered: 'none',
          phones: 0,
          apps: 0,
          note: `The user was not notified: no Wevir app is open. ${notPushed}`,
        });
      },
    },
  ];
}
