import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../shared/desktop-api.js';
import { fakeServer, manifestText, signText, testKeyPair } from '../test-fixtures/update-feed.js';
import { PROBE_BYTES } from './feed.js';
import type { FeedSource } from './mirror-provider.js';
import {
  defaultChannel,
  UpdateController,
  type UpdateControllerOptions,
  type UpdatePrefs,
} from './updater.js';

const GLOBAL = { id: 'global', url: 'https://download.example' };
const SECOND = { id: 'second', url: 'https://second.example' };
const BACKUP = { id: 'backup', url: 'https://backup.example', fallback: true as const };
const { privateKey, publicKey } = testKeyPair();

/** 照 electron-updater 的事件顺序：检查时向 provider 要清单，比当前版本新就 update-available。 */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  logger: unknown = null;
  feed: FeedSource | undefined;
  downloads: string[] = [];
  failDownloadsFrom = new Set<string>();
  installed: unknown[] = [];
  constructor(readonly currentVersion: string) {
    super();
  }
  setFeedURL(options: { feed: FeedSource }): void {
    this.feed = options.feed;
  }
  async checkForUpdates(): Promise<unknown> {
    const result = await this.feed?.latest();
    if (result === undefined) return null;
    this.lastBase = result.baseUrl;
    if (result.info.version !== this.currentVersion) this.emit('update-available', result.info);
    else this.emit('update-not-available');
    return result;
  }
  lastBase = '';
  async downloadUpdate(): Promise<unknown> {
    this.downloads.push(this.lastBase);
    if ([...this.failDownloadsFrom].some((host) => this.lastBase.startsWith(host))) {
      throw new Error(`download failed from ${this.lastBase}`);
    }
    this.emit('download-progress', { percent: 50, bytesPerSecond: 1000 });
    this.emit('update-downloaded', { version: '0.2.0' });
    return [];
  }
  quitAndInstall(...args: unknown[]): void {
    this.installed.push(args);
  }
}

function serve(version: string, mirrors = [GLOBAL, SECOND], delayMs: Record<string, number> = {}) {
  const routes: Record<string, string | Uint8Array> = {};
  for (const mirror of mirrors) {
    const base = `${mirror.url}/desktop/darwin-arm64/`;
    routes[`${base}latest-mac.yml`] = manifestText(version);
    routes[`${base}latest-mac.yml.sig`] = signText(manifestText(version), privateKey);
    routes[`${base}Wevir-${version}-mac-arm64.zip`] = new Uint8Array(PROBE_BYTES);
  }
  return fakeServer(routes, { delayMs });
}

function controller(options: {
  updater: FakeUpdater;
  fetcher: ReturnType<typeof serve>['fetcher'];
  prefs?: UpdatePrefs;
  packaged?: boolean;
  keys?: string[];
  readOnlyLocation?: boolean;
  timing?: Pick<UpdateControllerOptions, 'firstCheckMs' | 'staleAfterMs' | 'now'>;
  mirrors?: UpdateControllerOptions['mirrors'];
  prepareInstall?: UpdateControllerOptions['prepareInstall'];
}) {
  let prefs: UpdatePrefs = options.prefs ?? {};
  const states: UpdateState[] = [];
  const ctl = new UpdateController({
    updater: options.updater as never,
    currentVersion: options.updater.currentVersion,
    platform: 'darwin',
    arch: 'arm64',
    mirrors: options.mirrors ?? [GLOBAL, SECOND],
    publicKeys: options.keys ?? [publicKey],
    fetcher: options.fetcher,
    packaged: options.packaged ?? true,
    readOnlyLocation: options.readOnlyLocation ?? false,
    readPrefs: () => prefs,
    writePrefs: (next) => {
      prefs = next;
    },
    log: () => {},
    ...options.timing,
    ...(options.prepareInstall !== undefined && { prepareInstall: options.prepareInstall }),
  });
  ctl.onState((state) => states.push(state));
  return { ctl, states, prefs: () => prefs };
}

describe('UpdateController', () => {
  it('开发构建、没有公钥、只读位置时关闭；默认通道跟着当前版本', () => {
    const { fetcher } = serve('0.2.0');
    expect(
      controller({ updater: new FakeUpdater('0.1.0'), fetcher, packaged: false }).ctl.state,
    ).toMatchObject({
      phase: 'disabled',
      reason: 'development',
    });
    expect(
      controller({ updater: new FakeUpdater('0.1.0'), fetcher, keys: [] }).ctl.state,
    ).toMatchObject({
      reason: 'unsigned',
    });
    expect(
      controller({ updater: new FakeUpdater('0.1.0'), fetcher, readOnlyLocation: true }).ctl.state,
    ).toMatchObject({ reason: 'location' });
    expect(defaultChannel('0.2.0')).toBe('stable');
    expect(defaultChannel('0.2.1-beta.3')).toBe('dev');
  });

  it('检查 → 有新版本（按速度选线路）→ 下载 → 下载好 → 安装', async () => {
    const updater = new FakeUpdater('0.1.0');
    // 全球线路取清单快，但下载慢：选第二条线路下载。
    const { fetcher } = serve('0.2.0', [GLOBAL, SECOND], { [SECOND.url]: 5 });
    const slowZip: typeof fetcher = async (url, init) => {
      if (url.startsWith(GLOBAL.url) && url.endsWith('.zip'))
        await new Promise((r) => setTimeout(r, 60));
      return fetcher(url, init);
    };
    const { ctl, states } = controller({ updater, fetcher: slowZip });
    expect(updater.autoDownload).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    await ctl.check();
    expect(ctl.state).toMatchObject({
      phase: 'available',
      version: '0.2.0',
      mirror: { id: 'second' },
    });
    expect(ctl.state.lastCheckedAt).toBeDefined();
    await ctl.download();
    expect(states.map((s) => s.phase)).toEqual([
      'checking',
      'available',
      'available',
      'downloading',
      'downloading',
      'downloaded',
    ]);
    expect(updater.downloads[0]).toContain(SECOND.url);
    await ctl.install();
    expect(ctl.state.phase).toBe('installing');
    expect(updater.installed).toEqual([[true, true]]);
  });

  it('安装前先做完 prepareInstall（Windows 先停 Host），它失败也照常安装', async () => {
    for (const fail of [false, true]) {
      const updater = new FakeUpdater('0.1.0');
      let release = () => {};
      const prepared = new Promise<void>((resolve) => {
        release = resolve;
      });
      const order: string[] = [];
      const { ctl } = controller({
        updater,
        fetcher: serve('0.2.0').fetcher,
        prepareInstall: async () => {
          order.push('prepare');
          await prepared;
          if (fail) throw new Error('host did not stop');
        },
      });
      await ctl.check();
      await ctl.download();
      const installing = ctl.install();
      expect(ctl.state.phase).toBe('installing');
      expect(updater.installed).toEqual([]);
      release();
      await installing;
      expect(order).toEqual(['prepare']);
      expect(updater.installed).toEqual([[true, true]]);
    }
  });

  it('已是最新：latest', async () => {
    const updater = new FakeUpdater('0.2.0');
    const { ctl } = controller({ updater, fetcher: serve('0.2.0').fetcher });
    await ctl.check();
    expect(ctl.state.phase).toBe('latest');
  });

  it('该通道还没发布过版本（两条线路都没有清单）：latest，不报连不上', async () => {
    const updater = new FakeUpdater('0.0.1-beta.180');
    const { ctl } = controller({
      updater,
      fetcher: fakeServer({}).fetcher,
      prefs: { channel: 'stable' },
    });
    await ctl.check();
    expect(ctl.state.phase).toBe('latest');
  });

  it('两条线路都连不上：报 unreachable', async () => {
    const updater = new FakeUpdater('0.1.0');
    const { ctl } = controller({
      updater,
      fetcher: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });
    await ctl.check();
    expect(ctl.state).toMatchObject({ phase: 'error', code: 'unreachable' });
  });

  it('下载失败时换另一条线路重试一次', async () => {
    const updater = new FakeUpdater('0.1.0');
    const { ctl } = controller({
      updater,
      fetcher: serve('0.2.0', [GLOBAL, SECOND], { [SECOND.url]: 40 }).fetcher,
    });
    await ctl.check();
    const first = ctl.state.mirror?.id;
    updater.failDownloadsFrom.add(first === 'global' ? GLOBAL.url : SECOND.url);
    await ctl.download();
    await new Promise((r) => setTimeout(r, 100));
    expect(updater.downloads).toHaveLength(2);
    expect(ctl.state).toMatchObject({ phase: 'downloaded' });
    expect(ctl.state.mirror?.id).not.toBe(first);
  });

  it('主线路都给出清单时不问后备线路；主线路都下载失败时依次换到后备线路', async () => {
    const updater = new FakeUpdater('0.1.0');
    const mirrors = [GLOBAL, SECOND, BACKUP];
    const server = serve('0.2.0', mirrors);
    const { ctl } = controller({ updater, fetcher: server.fetcher, mirrors });
    await ctl.check();
    expect(ctl.state).toMatchObject({ phase: 'available', version: '0.2.0' });
    expect(server.requests.some((r) => r.url.startsWith(BACKUP.url))).toBe(false);

    updater.failDownloadsFrom.add(GLOBAL.url).add(SECOND.url);
    await ctl.download();
    await new Promise((r) => setTimeout(r, 200));
    expect(updater.downloads).toHaveLength(3);
    expect(updater.downloads[2]?.startsWith(BACKUP.url)).toBe(true);
    expect(ctl.state).toMatchObject({ phase: 'downloaded', mirror: { id: 'backup' } });
  });

  it('两条线路都下载失败：报 download', async () => {
    const updater = new FakeUpdater('0.1.0');
    updater.failDownloadsFrom.add(GLOBAL.url).add(SECOND.url);
    const { ctl } = controller({ updater, fetcher: serve('0.2.0').fetcher });
    await ctl.check();
    await ctl.download();
    await new Promise((r) => setTimeout(r, 100));
    expect(ctl.state).toMatchObject({ phase: 'error', code: 'download' });
  });

  it('清单被篡改：报 signature，不下载', async () => {
    const updater = new FakeUpdater('0.1.0');
    const other = testKeyPair();
    const { ctl } = controller({
      updater,
      fetcher: serve('0.2.0').fetcher,
      keys: [other.publicKey],
    });
    await ctl.check();
    expect(ctl.state).toMatchObject({ phase: 'error', code: 'signature' });
    expect(updater.downloads).toEqual([]);
  });

  it('换通道：记下并重新检查', async () => {
    const updater = new FakeUpdater('0.2.0');
    const { ctl, prefs } = controller({ updater, fetcher: serve('0.2.0').fetcher });
    expect(ctl.state.channel).toBe('stable');
    await ctl.setChannel('dev');
    expect(prefs()).toEqual({ channel: 'dev' });
    // 还没有 beta 的清单：只看正式版的，照样是最新。
    expect(ctl.state).toMatchObject({ channel: 'dev', phase: 'latest' });
  });

  it('唤醒或回到前台：上次检查过久才补查，第一次检查之前与刚查过时不查', async () => {
    const updater = new FakeUpdater('0.2.0');
    let checks = 0;
    const check = updater.checkForUpdates.bind(updater);
    updater.checkForUpdates = () => {
      checks += 1;
      return check();
    };
    let offset = 0;
    const { ctl } = controller({
      updater,
      fetcher: serve('0.2.0').fetcher,
      timing: { firstCheckMs: 60_000, staleAfterMs: 1_000, now: () => Date.now() + offset },
    });
    // 还没 start：不补查。
    ctl.checkIfStale();
    ctl.start();
    // 第一次定时检查之前：不补查。
    ctl.checkIfStale();
    await new Promise((r) => setTimeout(r, 20));
    expect(checks).toBe(0);
    await ctl.check();
    expect(checks).toBe(1);
    // 刚查过：不补查。
    ctl.checkIfStale();
    await new Promise((r) => setTimeout(r, 20));
    expect(checks).toBe(1);
    // 过了 staleAfterMs（例如合盖睡了一夜）：补查一次。
    offset = 5_000;
    ctl.checkIfStale();
    await new Promise((r) => setTimeout(r, 50));
    expect(checks).toBe(2);
    expect(ctl.state.phase).toBe('latest');
    ctl.stop();
  });
});
