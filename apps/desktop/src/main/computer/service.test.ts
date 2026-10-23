// 电脑操作（0.114.0）在主进程里的一层：档位、授权只认授权框里的、坐标换算、按窗口在后台操作、batch 遇错即停、Esc 停下与平台检查。
// helper 换成假的，记下收到的请求。

import type { ComputerRequest } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { HelperError, type HelperLike, type HelperResult } from './helper.js';
import { type ComputerOverlay, ComputerService } from './service.js';
import { accessTier } from './tiers.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';

const APPS = [
  {
    pid: 11,
    name: 'Notes',
    bundleId: 'com.apple.Notes',
    windows: [
      // 自动更正的气泡：在第 0 层、排在主窗口前面，截“这个应用”时不该选它。
      { windowId: 502, x: 300, y: 300, width: 63, height: 22 },
      { windowId: 501, title: 'Notes', x: 100, y: 50, width: 800, height: 600 },
    ],
  },
  { pid: 12, name: 'Terminal', bundleId: 'com.apple.Terminal', windows: [] },
];

function fakeHelper(
  overrides: Record<string, (params: Record<string, unknown>) => HelperResult> = {},
) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  let listener: ((event: HelperResult) => void) | undefined;
  const helper: HelperLike = {
    async request(op, params = {}) {
      calls.push({ op, params });
      const override = overrides[op];
      if (override) return override(params);
      switch (op) {
        case 'status':
          return { screenRecording: true, accessibility: true, macos: '15.0.0' };
        case 'resolve_apps':
          return {
            apps: (params.names as string[]).map((query) => {
              if (query === 'Notes')
                return {
                  query,
                  bundleId: 'com.apple.Notes',
                  name: 'Notes',
                  path: '/System/Applications/Notes.app',
                };
              if (query === 'Terminal')
                return { query, bundleId: 'com.apple.Terminal', name: 'Terminal', path: '/t.app' };
              if (query === 'Safari')
                return {
                  query,
                  bundleId: 'com.apple.Safari',
                  name: 'Safari',
                  path: '/s.app',
                  browser: true,
                };
              if (query === 'Wevir')
                return { query, bundleId: 'si.wevir.desktop', name: 'Wevir', path: '/w.app' };
              return { query };
            }),
          };
        case 'list_apps':
          return { apps: APPS };
        case 'frontmost':
          return { pid: 11, name: 'Notes', bundleId: 'com.apple.Notes' };
        case 'screenshot':
          return {
            data: 'AAAA',
            mimeType: 'image/jpeg',
            width: 1400,
            height: 875,
            originX: params.windowId === undefined ? 0 : 100,
            originY: params.windowId === undefined ? 0 : 50,
            scale: 0.5,
            ...(params.windowId !== undefined && { windowId: params.windowId }),
          };
        default:
          return { method: 'pointer', app: { name: 'Notes', pid: 11 } };
      }
    },
    onEvent(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return { helper, calls, emit: (event: HelperResult) => listener?.(event) };
}

function setup(
  options: {
    platform?: NodeJS.Platform;
    darwinMajor?: number;
    overrides?: Parameters<typeof fakeHelper>[0];
  } = {},
) {
  const fake = fakeHelper(options.overrides);
  const overlayCalls: string[] = [];
  const overlay: ComputerOverlay = {
    show: () => overlayCalls.push('show'),
    hide: () => overlayCalls.push('hide'),
    windowIds: () => [9999],
  };
  const stopped: string[][] = [];
  const service = new ComputerService({
    helper: fake.helper,
    overlay,
    platform: options.platform ?? 'darwin',
    darwinMajor: options.darwinMajor ?? 24,
    onStopped: (ids) => stopped.push(ids),
  });
  return { service, ...fake, overlayCalls, stopped };
}

const command = (value: ComputerRequest['command']) =>
  ({ sessionId: SESSION, command: value }) as Pick<ComputerRequest, 'sessionId' | 'command'>;

async function approve(service: ComputerService, apps: string[], approved: string[]) {
  const prepared = await service.prepareAccess(SESSION, apps, 'test');
  return { prepared, answer: service.grant(prepared.accessId, approved) };
}

describe('档位', () => {
  it('浏览器只读，终端与 IDE 只能点击，Wevir 不能授权，其余完全控制', () => {
    expect(accessTier({ bundleId: 'com.apple.Safari' })).toBe('read');
    expect(accessTier({ bundleId: 'com.example.NewBrowser', browser: true })).toBe('read');
    expect(accessTier({ bundleId: 'com.apple.Terminal' })).toBe('click');
    expect(accessTier({ bundleId: 'com.jetbrains.intellij' })).toBe('click');
    expect(accessTier({ bundleId: 'si.wevir.desktop' })).toBeUndefined();
    expect(accessTier({ bundleId: 'com.apple.Notes' })).toBe('full');
  });
});

describe('ComputerService', () => {
  it('不是 macOS、低于 macOS 14 时一律回 computer_unsupported，不碰 helper', async () => {
    for (const options of [{ platform: 'win32' as const }, { darwinMajor: 22 }]) {
      const { service, calls } = setup(options);
      const answer = await service.execute(command({ command: 'list_apps', args: {} }));
      expect(answer).toMatchObject({ ok: false, error: { code: 'computer_unsupported' } });
      await expect(service.prepareAccess(SESSION, ['Notes'], 'x')).rejects.toMatchObject({
        code: 'computer_unsupported',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('缺系统权限时不弹框，说明缺哪一项', async () => {
    const { service } = setup({
      overrides: { status: () => ({ screenRecording: false, accessibility: true }) },
    });
    await expect(service.prepareAccess(SESSION, ['Notes'], 'x')).rejects.toThrow(
      /Screen Recording/,
    );
  });

  it('授权框：档位按应用的种类，找不到的与 Wevir 自己分开列；只记下框里有、用户批准的', async () => {
    const { service } = setup();
    const { prepared, answer } = await approve(
      service,
      ['Notes', 'Safari', 'Terminal', 'Wevir', 'Nope'],
      ['com.apple.Notes', 'com.apple.Safari', 'com.evil.Injected'],
    );
    expect(prepared.candidates.map((app) => [app.bundleId, app.tier])).toEqual([
      ['com.apple.Notes', 'full'],
      ['com.apple.Safari', 'read'],
      ['com.apple.Terminal', 'click'],
    ]);
    expect(prepared.notFound).toEqual(['Nope']);
    expect(prepared.refused).toEqual(['Wevir']);
    expect(answer.ok).toBe(true);
    const text =
      answer.ok && answer.result.content[0]?.type === 'text' ? answer.result.content[0].text : '';
    expect(text.startsWith('Approved: Notes (com.apple.Notes, full control); Safari')).toBe(true);
    expect(text).toContain('Not approved by the user: Terminal.');
    expect(text).not.toContain('Injected');
    // 同一个授权只能用一次。
    expect(service.grant(prepared.accessId, ['com.apple.Terminal'])).toMatchObject({ ok: false });
  });

  it('一个都没批准时回 computer_denied', async () => {
    const { service } = setup();
    const { answer } = await approve(service, ['Notes'], []);
    expect(answer).toMatchObject({ ok: false, error: { code: 'computer_denied' } });
  });

  it('没有授权时动作回 computer_not_granted；列出应用不用授权', async () => {
    const { service } = setup();
    expect(
      await service.execute(command({ command: 'key', args: { keys: 'cmd+s' } })),
    ).toMatchObject({
      ok: false,
      error: { code: 'computer_not_granted' },
    });
    const listed = await service.execute(command({ command: 'list_apps', args: {} }));
    expect(listed.ok && listed.result.content[0]).toMatchObject({
      text: expect.stringContaining('- Notes (com.apple.Notes) access=none frontmost'),
    });
  });

  it('截屏幕只含批准过的应用；坐标按最近一张截图换成屏幕上的点，带上档位与要跳过的提示条', async () => {
    const { service, calls, overlayCalls } = setup();
    await approve(service, ['Notes'], ['com.apple.Notes']);
    const shot = await service.execute(command({ command: 'screenshot', args: {} }));
    expect(shot.ok && shot.result.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(calls.find((call) => call.op === 'screenshot')?.params).toMatchObject({ pids: [11] });
    await service.execute(command({ command: 'click', args: { x: 200, y: 100 } }));
    expect(calls.find((call) => call.op === 'click')?.params).toEqual({
      allow: { 'com.apple.Notes': 'full' },
      scope: SESSION,
      ignoreWindowIds: [9999],
      x: 400,
      y: 200,
    });
    expect(overlayCalls).toEqual(['show']);
    expect(calls.some((call) => call.op === 'watch_escape' && call.params.on === true)).toBe(true);
    expect(
      await service.execute(command({ command: 'click', args: { x: 2000, y: 10 } })),
    ).toMatchObject({
      ok: false,
      error: { code: 'computer_invalid_argument' },
    });
  });

  it('截一个窗口之后，点击与按键发给那个窗口（后台）', async () => {
    const { service, calls } = setup();
    await approve(service, ['Notes'], ['com.apple.Notes']);
    await service.execute(command({ command: 'screenshot', args: { app: 'Notes' } }));
    expect(calls.find((call) => call.op === 'screenshot')?.params).toMatchObject({ windowId: 501 });
    await service.execute(command({ command: 'click', args: { x: 10, y: 20 } }));
    expect(calls.find((call) => call.op === 'click')?.params).toMatchObject({
      x: 120,
      y: 90,
      background: true,
      pid: 11,
      windowId: 501,
    });
    await service.execute(command({ command: 'type', args: { text: 'hi' } }));
    expect(calls.find((call) => call.op === 'type')?.params).toMatchObject({ text: 'hi', pid: 11 });
  });

  it('没批准的应用不能截窗口、读树或打开', async () => {
    const { service } = setup();
    await approve(service, ['Notes'], ['com.apple.Notes']);
    for (const value of [
      { command: 'screenshot', args: { app: 'Terminal' } },
      { command: 'ax_tree', args: { app: 'com.apple.Terminal' } },
      { command: 'open_app', args: { app: 'Terminal' } },
    ] as const) {
      expect(await service.execute(command(value))).toMatchObject({
        ok: false,
        error: { code: 'computer_not_granted' },
      });
    }
  });

  it('batch 顺序执行，遇到错误就停，带上已经做完的步骤', async () => {
    const { service, calls } = setup({
      overrides: {
        key: () => {
          throw new HelperError('computer_tier_denied', 'Terminal is click only.');
        },
      },
    });
    await approve(service, ['Notes'], ['com.apple.Notes']);
    const answer = await service.execute(
      command({
        command: 'batch',
        args: {
          actions: [
            { command: 'click', args: { ref: '@a1' } },
            { command: 'key', args: { keys: 'cmd+s' } },
            { command: 'type', args: { text: 'never' } },
          ],
        },
      }),
    );
    expect(answer).toMatchObject({ ok: false, error: { code: 'computer_tier_denied' } });
    const text = !answer.ok && answer.content?.[0]?.type === 'text' ? answer.content[0].text : '';
    expect(text).toContain('1. click: Clicked @a1 in Notes');
    expect(text).toContain('2. key: failed, computer_tier_denied');
    expect(text).toContain('the remaining 1 step(s) were not run');
    expect(calls.some((call) => call.op === 'type')).toBe(false);
  });

  it('Esc：在操作的会话停下、授权作废，之后回 computer_stopped，重新批准后恢复', async () => {
    const { service, emit, stopped, overlayCalls } = setup();
    await approve(service, ['Notes'], ['com.apple.Notes']);
    await service.execute(command({ command: 'key', args: { keys: 'Return' } }));
    emit({ event: 'escape' });
    expect(stopped).toEqual([[SESSION]]);
    expect(overlayCalls).toEqual(['show', 'hide']);
    expect(
      await service.execute(command({ command: 'key', args: { keys: 'Return' } })),
    ).toMatchObject({
      ok: false,
      error: { code: 'computer_stopped' },
    });
    await approve(service, ['Notes'], ['com.apple.Notes']);
    expect((await service.execute(command({ command: 'key', args: { keys: 'Return' } }))).ok).toBe(
      true,
    );
  });

  it('回合结束（不在活动会话里）时收起提示条、不再监听 Esc', async () => {
    const { service, calls, overlayCalls } = setup();
    await approve(service, ['Notes'], ['com.apple.Notes']);
    await service.execute(command({ command: 'key', args: { keys: 'Return' } }));
    service.setActiveSessions([SESSION]);
    expect(overlayCalls).toEqual(['show']);
    service.setActiveSessions([]);
    expect(overlayCalls).toEqual(['show', 'hide']);
    expect(
      calls.filter((call) => call.op === 'watch_escape').map((call) => call.params.on),
    ).toEqual([true, false]);
  });
});
