// agent 的提醒（0.142.0）：`wevir_notify` 的整理、每会话限频与结果里的去向。通知服务与推送都是假的，不连推送网关、不碰真设备；
// 推送载荷的加密与正文在 remote/push.test.ts，意图的判定在 notifications.test.ts。

import type { NotificationIntent, SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type AppTool, AppToolError } from './app-mcp.js';
import type { AgentIntentRefusal } from './notifications.js';
import {
  NOTIFY_MAX_PER_HOUR,
  NOTIFY_MIN_INTERVAL_MS,
  NOTIFY_TOOL,
  NotifyRateLimiter,
  notifyTools,
  shapeAgentNotification,
} from './notify-tool.js';
import type { PushRecipients } from './remote/push.js';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const SES2 = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS' as SessionId;
const NOW = Date.parse('2026-10-30T08:00:00.000Z');

function fakes(
  options: {
    refused?: AgentIntentRefusal['refused'];
    apps?: number;
    push?: PushRecipients | undefined;
  } = {},
) {
  let now = NOW;
  const published: NotificationIntent[] = [];
  const pushChecked: NotificationIntent[] = [];
  const tools = notifyTools({
    notifications: {
      agentIntent: (sessionId, message) =>
        options.refused !== undefined
          ? { refused: options.refused }
          : {
              id: `agent:${sessionId}:${now}`,
              kind: 'agent',
              sessionId,
              title: message.title ?? 'Session title',
              body: message.body,
              createdAt: new Date(now).toISOString(),
              collapseKey: `agent:${sessionId}`,
            },
      publish: (intent) => {
        published.push(intent);
        return options.apps ?? 1;
      },
    },
    ...(options.push !== undefined && {
      push: {
        recipients: (intent: NotificationIntent) => {
          pushChecked.push(intent);
          return options.push as PushRecipients;
        },
      },
    }),
    now: () => now,
  });
  const tool = tools.find((entry) => entry.name === NOTIFY_TOOL) as AppTool;
  const call = async (args: Record<string, unknown>, sessionId: SessionId = SES) => {
    const result = await tool.call(args, { sessionId } as never);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    return JSON.parse(text) as Record<string, unknown>;
  };
  return {
    tool,
    call,
    published,
    pushChecked,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('shapeAgentNotification', () => {
  it('折成一行、去掉首尾空白；标题可省略', () => {
    expect(shapeAgentNotification({ body: '  Build\n finished.\t ' })).toEqual({
      body: 'Build finished.',
    });
    expect(shapeAgentNotification({ title: ' Deploy\n', body: 'Done.' })).toEqual({
      title: 'Deploy',
      body: 'Done.',
    });
    expect(shapeAgentNotification({ title: '   ', body: 'Done.' })).toEqual({ body: 'Done.' });
  });

  it('空正文、超长、类型不对的拒绝，不截断', () => {
    expect(() => shapeAgentNotification({ body: ' \n ' })).toThrow(AppToolError);
    expect(() => shapeAgentNotification({})).toThrow(/body must not be empty/);
    expect(() => shapeAgentNotification({ body: 'x'.repeat(201) })).toThrow(/at most 200/);
    expect(shapeAgentNotification({ body: 'x'.repeat(200) }).body).toHaveLength(200);
    expect(() => shapeAgentNotification({ title: 't'.repeat(81), body: 'x' })).toThrow(
      /at most 80/,
    );
    expect(() => shapeAgentNotification({ body: 42 })).toThrow(/string/);
    expect(() => shapeAgentNotification({ title: ['x'], body: 'x' })).toThrow(/string/);
  });

  it('像密钥的内容拒绝，不打码后照发', () => {
    expect(() =>
      shapeAgentNotification({ body: 'Use sk-abcdefghijklmnopqrstuvwxyz0123 to log in' }),
    ).toThrow(/secret/);
    expect(() =>
      shapeAgentNotification({ title: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', body: 'x' }),
    ).toThrow(/secret/);
  });
});

describe('NotifyRateLimiter', () => {
  it('同一会话至少隔一分钟，一小时最多六条；别的会话不受影响', () => {
    const limiter = new NotifyRateLimiter();
    let now = NOW;
    expect(limiter.check(SES, now)).toEqual({ ok: true });
    limiter.record(SES, now);
    expect(limiter.check(SES, now + 1000)).toEqual({
      ok: false,
      retryAfterMs: NOTIFY_MIN_INTERVAL_MS - 1000,
    });
    expect(limiter.check(SES2, now + 1000)).toEqual({ ok: true });
    for (let n = 1; n < NOTIFY_MAX_PER_HOUR; n += 1) {
      now += NOTIFY_MIN_INTERVAL_MS;
      expect(limiter.check(SES, now).ok).toBe(true);
      limiter.record(SES, now);
    }
    now += NOTIFY_MIN_INTERVAL_MS;
    // 第七条要等到第一条满一小时。
    expect(limiter.check(SES, now)).toEqual({ ok: false, retryAfterMs: NOW + 3_600_000 - now });
    expect(limiter.check(SES, NOW + 3_600_000).ok).toBe(true);
  });
});

describe('wevir_notify', () => {
  it('不用批准、不标只读（只读角色没有它）', () => {
    const { tool } = fakes();
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.description).toMatch(/not for progress/);
  });

  it('电脑前没人、有开了推送的手机：推到手机，结果说几台', async () => {
    const t = fakes({ push: { devices: 2 }, apps: 1 });
    expect(
      await t.call({ title: 'Deploy', body: 'Staging is down; approve the rollback.' }),
    ).toEqual({
      delivered: 'phone',
      phones: 2,
      apps: 1,
      note: 'Sent to the push service for 2 phones and shown by the open Wevir app.',
    });
    expect(t.published).toHaveLength(1);
    expect(t.published[0]).toMatchObject({ kind: 'agent', title: 'Deploy' });
    // 推送的判定在发出意图之前（否则发出后每小时的计数已经变了）。
    expect(t.pushChecked).toEqual(t.published);
  });

  it('推不了时退回桌面：结果说没推的原因', async () => {
    const off = fakes({ push: { devices: 0, skipped: 'off' }, apps: 1 });
    expect(await off.call({ body: 'Tests pass; ready to merge?' })).toMatchObject({
      delivered: 'app',
      phones: 0,
      apps: 1,
    });
    expect((await fakes({ apps: 1 }).call({ body: 'x' })).note).toMatch(
      /Not pushed: push to phones is off/,
    );
    const here = fakes({ push: { devices: 0, skipped: 'at_computer' }, apps: 1 });
    expect((await here.call({ body: 'x' })).note).toMatch(/the user is at the computer/);
    const none = fakes({ push: { devices: 0, skipped: 'no_device' }, apps: 1 });
    expect((await none.call({ body: 'x' })).note).toMatch(/no paired phone/);
  });

  it('没有手机也没有开着的 App：说没送到', async () => {
    const t = fakes({ push: { devices: 0, skipped: 'no_device' }, apps: 0 });
    expect(await t.call({ body: 'x' })).toEqual({
      delivered: 'none',
      phones: 0,
      apps: 0,
      note: 'The user was not notified: no Wevir app is open. Not pushed: no paired phone has push turned on.',
    });
  });

  it('种类开关关着：不发、不计数，结果叫模型别再试', async () => {
    const t = fakes({ refused: 'off', push: { devices: 1 } });
    expect(await t.call({ body: 'x' })).toEqual({
      delivered: 'none',
      reason: 'The user turned off agent notifications in Wevir settings. Do not retry.',
    });
    expect(t.published).toEqual([]);
    expect(t.pushChecked).toEqual([]);
    // 没算进限频。
    expect(await t.call({ body: 'x' })).toMatchObject({ delivered: 'none' });
  });

  it('子会话等与不在了的会话：报错', async () => {
    await expect(fakes({ refused: 'nested' }).call({ body: 'x' })).rejects.toThrow(
      /Only top-level sessions/,
    );
    await expect(fakes({ refused: 'session' }).call({ body: 'x' })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('限频：一分钟内第二条报错且不发，过了间隔照发；参数不对的不计数', async () => {
    const t = fakes({ push: { devices: 1 } });
    await expect(t.call({ body: '' })).rejects.toThrow(/empty/);
    await t.call({ body: 'first' });
    await expect(t.call({ body: 'second' })).rejects.toThrow(/wait 60 s/);
    await t.call({ body: 'other session' }, SES2);
    t.advance(NOTIFY_MIN_INTERVAL_MS);
    await t.call({ body: 'third' });
    expect(t.published.map((intent) => intent.body)).toEqual(['first', 'other session', 'third']);
  });
});
