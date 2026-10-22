// wevir remote 与 --remote 对着另一个数据目录里的真实 Host（startHost + EchoAdapter，远程监听把 127.0.0.1 当作局域网网卡）：CLI 的
// 数据目录里没有 Host，扮演另一台电脑上的 CLI。配对链接与短码配对、记录文件的权限、经远程列会话、发消息、看收件箱、回答审批，
// 只能本机跑的命令拒绝 --remote，电脑上移除设备后被拒，forget。

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type WevirClient, webSocketTransport } from '@wevir/client-sdk';
import { connectLocalHost } from '@wevir/client-sdk/node';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import {
  DEFAULT_REMOTE_SETTINGS,
  type InboxItem,
  parsePairingUri,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscoveredHost } from './remote/mdns.js';
import { REMOTE_HOSTS_DIR } from './remote/store.js';
import { run, runFake, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Announcement {
  name: string;
  port: number;
  txt: Readonly<Record<string, string>>;
  restrictedAddresses: readonly string[];
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** “另一台电脑”：自己的数据目录与 Host，远程访问打开、在 127.0.0.1 上监听；`desktop` 是那台电脑上的桌面端。 */
async function otherComputer() {
  const home = join(tempDir(), 'other-computer');
  const announcements: (Announcement | undefined)[] = [];
  const host: RunningHost = await startHost({
    home,
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    remoteListener: {
      networkInterfaces: () => ({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      }),
      classifyAddress: (address) => (address === '127.0.0.1' ? 'lan' : null),
      lookupMagicDnsName: async () => undefined,
      advertiser: { update: (a) => announcements.push(a), shutdown: async () => {} },
      pollMs: 50,
    },
  });
  cleanups.push(() => host.shutdown());
  const desktop: WevirClient = await connectLocalHost({
    home,
    identity: { clientKind: 'desktop', deviceId: 'mac', clientId: 'desktop' },
    transport: webSocketTransport(globalThis.WebSocket),
  });
  cleanups.push(() => desktop.close());
  const port = await freePort();
  const listening = new Promise<void>((resolve) => {
    const stop = desktop.onRemoteDevicesChanged((change) => {
      if (change?.kind === 'listener' && change.status.listening) {
        stop();
        resolve();
      }
    });
  });
  await desktop.request('remote.status');
  await desktop.request('settings.update', {
    settings: {
      remote: {
        ...DEFAULT_REMOTE_SETTINGS,
        enabled: true,
        interfaces: { lan: true, tailscale: false },
        port,
      },
    },
  });
  await listening;
  /** 对下一个配对请求作答。 */
  const respond = (allow: boolean) =>
    new Promise<string>((resolve) => {
      const stop = desktop.onRemoteDevicesChanged((change) => {
        if (change?.kind !== 'pairing_request') return;
        stop();
        void desktop
          .request('pairing.respond', { requestId: change.request.requestId, allow })
          .then(() => resolve(change.request.name));
      });
    });
  /** 这台电脑在局域网里的 mDNS 广播，交给 CLI 的“发现”。 */
  const discovered = (): DiscoveredHost => {
    const last = announcements.at(-1) as Announcement;
    return {
      routeId: last.txt.rid ?? '',
      hostPublicKey: last.txt.pk ?? '',
      port: last.port,
      addresses: last.restrictedAddresses,
    };
  };
  return { home, host, desktop, port, respond, discovered };
}

async function createSession(desktop: WevirClient): Promise<SessionId> {
  const dir = join(tempDir(), 'project');
  mkdirSync(dir, { recursive: true });
  const { workspace } = await desktop.request('workspace.add', { rootPath: dir });
  await desktop.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await desktop.request('session.create', {
    workspaceId: workspace.id,
    providerId: 'deepseek-official',
  });
  return session.id;
}

/** 用配对链接配对，名称 `office`。 */
async function pairByLink(other: Awaited<ReturnType<typeof otherComputer>>, cliHome: string) {
  const offer = await other.desktop.request('pairing.start');
  const allowed = other.respond(true);
  const paired = await run(
    ['remote', 'pair', offer.uri, '--name', 'office', '--device-name', 'Laptop'],
    { home: cliHome },
  );
  expect(paired.code, paired.err).toBe(0);
  expect(await allowed).toBe('Laptop');
  return { offer, paired };
}

describe('wevir remote', () => {
  it('配对链接配对 → --remote 列会话、发消息、看收件箱、回答审批；只能本机跑的命令拒绝 --remote', async () => {
    const other = await otherComputer();
    const cliHome = join(tempDir(), 'laptop');
    const { offer, paired } = await pairByLink(other, cliHome);
    expect(paired.out).toContain('等待');
    expect(paired.out).toContain('已与');
    expect(paired.out).toContain('名称 office');
    expect(paired.out).toContain('wevir --remote office session list');

    // 记录文件：目录 0700、文件 0600，--json 不含私钥。
    const dir = join(cliHome, REMOTE_HOSTS_DIR);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'office.json')).mode & 0o777).toBe(0o600);
    const listed = await run(['remote', 'list', '--json'], { home: cliHome });
    expect(listed.code, listed.err).toBe(0);
    const records = JSON.parse(listed.out) as Record<string, unknown>[];
    expect(records).toMatchObject([
      {
        name: 'office',
        hostPublicKey: offer.hostPublicKey,
        routeId: offer.routeId,
        candidates: [{ kind: 'lan', host: '127.0.0.1', port: other.port }],
        lastAddress: { host: '127.0.0.1', port: other.port },
      },
    ]);
    expect(records[0]).not.toHaveProperty('deviceSecretKey');
    const table = await run(['remote', 'list'], { home: cliHome, lang: 'en' });
    expect(table.out).toMatch(/Name\s+Computer\s+Address/);
    expect(table.out).toContain(`office  `);

    const sessionId = await createSession(other.desktop);
    const sessions = await run(['--remote', 'office', 'session', 'list'], { home: cliHome });
    expect(sessions.code, sessions.err).toBe(0);
    expect(sessions.out).toContain(sessionId);

    const sent = await run(['session', 'send', '--remote', 'office', sessionId, 'please approve'], {
      home: cliHome,
    });
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out).toContain('已发送');

    let items: InboxItem[] = [];
    const deadline = Date.now() + 10_000;
    while (items.length === 0 && Date.now() < deadline) {
      const inbox = await run(['--remote', 'office', 'inbox', '--json'], { home: cliHome });
      expect(inbox.code, inbox.err).toBe(0);
      items = JSON.parse(inbox.out) as InboxItem[];
      if (items.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [item] = items;
    expect(item?.kind).toBe('approval');
    const bad = await run(['--remote', 'office', 'inbox', 'respond', item?.id ?? '', 'maybe'], {
      home: cliHome,
    });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('认不出的回答');
    const answered = await run(
      ['--remote', 'office', 'inbox', 'respond', (item?.id ?? '').replace(/^approval:/, ''), 'y'],
      { home: cliHome },
    );
    expect(answered.code, answered.err).toBe(0);
    expect(answered.out).toContain(`已回答 ${item?.id}`);
    // 审批由引擎接受回复之后才离开收件箱。
    let left: InboxItem[] = items;
    const until = Date.now() + 10_000;
    while (left.some((i) => i.id === item?.id) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const inbox = await run(['--remote', 'office', 'inbox', '--json'], { home: cliHome });
      left = JSON.parse(inbox.out) as InboxItem[];
    }
    expect(left.map((i) => i.id)).not.toContain(item?.id);

    // 默认权限里没有 provider.read：报缺的权限与去哪里加。
    const providers = await run(['--remote', 'office', 'provider', 'list'], { home: cliHome });
    expect(providers.code).toBe(1);
    expect(providers.err).toContain('没有权限：provider.read');
    // 远程电脑上的路径必须是绝对路径。
    const relative = await run(
      ['--remote', 'office', 'session', 'new', '-w', 'project', '--detach', 'hi'],
      { home: cliHome },
    );
    expect(relative.code).toBe(2);
    expect(relative.err).toContain('绝对路径');
    const local = await run(['--remote', 'office', 'host', 'status'], { home: cliHome });
    expect(local.code).toBe(2);
    expect(local.err).toContain('只能在本机执行');
    const unknown = await run(['--remote', 'home', 'session', 'list'], { home: cliHome });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('没有配对过名为 home 的电脑');
  }, 30_000);

  it('短码配对靠 mDNS 发现的 rid 与 pk；电脑上移除设备后被拒；forget 删掉记录', async () => {
    const other = await otherComputer();
    const cliHome = join(tempDir(), 'laptop');
    const offer = await other.desktop.request('pairing.start');
    const browseMdns = async () => [other.discovered()];

    // 错码：握手报短码不对，窗口结束。
    const wrongCode = offer.shortCode === '00000000' ? '1111-1111' : '0000-0000';
    const wrong = await run(['remote', 'pair', wrongCode], { home: cliHome, browseMdns });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('短码或配对链接不对');

    const again = await other.desktop.request('pairing.start');
    const allowed = other.respond(true);
    const fake = runFake(['remote', 'pair', again.shortCode.toLowerCase()], {
      home: cliHome,
      browseMdns,
    });
    fake.stdin.end();
    expect(await fake.exit, fake.err()).toBe(0);
    await allowed;
    // 名称取自电脑名称；没有时是 computer。
    const listed = JSON.parse((await run(['remote', 'list', '--json'], { home: cliHome })).out);
    const name = listed[0].name as string;
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(listed[0].routeId).toBe(parsePairingUri(again.uri)?.routeId);
    const ok = await run(['--remote', name, 'session', 'list'], { home: cliHome });
    expect(ok.code, ok.err).toBe(0);

    const { devices } = await other.desktop.request('device.list');
    await other.desktop.request('device.revoke', {
      id: (devices[0] as (typeof devices)[number]).id,
    });
    const rejected = await run(['--remote', name, 'session', 'list'], { home: cliHome });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain('那台电脑拒绝了本设备');
    expect(rejected.err).toContain('wevir remote pair');

    const forgot = await run(['remote', 'forget', name], { home: cliHome });
    expect(forgot.code, forgot.err).toBe(0);
    expect((await run(['remote', 'list'], { home: cliHome })).out).toContain('暂无配对过的电脑');
  }, 30_000);

  it('短码时局域网里找不到电脑：说明原因并建议用配对链接', async () => {
    const cliHome = join(tempDir(), 'laptop');
    const result = await run(['remote', 'pair', 'ABCD-EFGH'], { home: cliHome });
    expect(result.code).toBe(1);
    expect(result.err).toContain('局域网里没有找到');
    const bad = await run(['remote', 'pair', 'hello'], { home: cliHome });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('既不是配对链接也不是短码');
  });
});
