// 项目安装走一遍真实的 npm：测试里起一个本机的 npm 仓库（要令牌、可以变慢、可以关掉），项目的 `.npmrc` 指向它，缓存与 HOME 都在临时目录。
// 覆盖：私有仓库认证失败 → 存凭据后成功（日志与记录里没有令牌）、依赖的 postinstall 跑了、有缓存时仓库关掉也装得上、没缓存时离线是网络
// 失败、安装中取消再重试、方案过期被拒、同一目录不能同时装、Host 退出时取消与重启后对账。POSIX 上跑（Windows 的 shell 不同）。

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { InstallRun, ReadinessReport, WorkspaceId } from '@wevir/protocol';
import { FileSecretStore, openStorage, type Storage } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { HostError } from '../errors.js';
import { ReadinessService } from './service.js';

const TOKEN = 'reg-token-0123456789';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 最小的 ustar 归档：`package/<文件>`。 */
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
      136,
    );
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

interface Registry {
  url: string;
  requests: string[];
  delayMs: number;
  close(): Promise<void>;
  integrity(name: string): string;
}

/** 本机 npm 仓库：只认 `Authorization: Bearer TOKEN`，两个包，`scripted` 有 postinstall。 */
async function startRegistry(): Promise<Registry> {
  const packages: Record<string, Buffer> = {
    left: tarball({
      'package.json': JSON.stringify({ name: 'left', version: '1.0.0' }),
      'index.js': 'module.exports = 1;\n',
    }),
    scripted: tarball({
      'package.json': JSON.stringify({
        name: 'scripted',
        version: '1.0.0',
        scripts: {
          postinstall: `node -e "require('fs').writeFileSync(process.env.INIT_CWD + '/postinstall-ran', 'x')"`,
        },
      }),
    }),
  };
  const state = { delayMs: 0, requests: [] as string[] };
  const server: Server = createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const match = /^\/([a-z]+)\/-\/[a-z]+-1\.0\.0\.tgz$/.exec(req.url ?? '');
    const body = match ? packages[match[1] as string] : undefined;
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    }, state.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let closed = false;
  const registry: Registry = {
    url,
    requests: state.requests,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    close: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            closed = true;
            server.closeAllConnections();
            server.close(() => resolve());
          }),
    integrity: (name) =>
      `sha512-${createHash('sha512')
        .update(packages[name] as Buffer)
        .digest('base64')}`,
  };
  cleanups.push(() => registry.close());
  return registry;
}

function writeProject(root: string, registry: Registry) {
  const host = registry.url.replace(/^http:/, '');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      dependencies: { left: '1.0.0', scripted: '1.0.0' },
    }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'demo', version: '1.0.0', dependencies: { left: '1.0.0', scripted: '1.0.0' } },
        'node_modules/left': {
          version: '1.0.0',
          resolved: `${registry.url}left/-/left-1.0.0.tgz`,
          integrity: registry.integrity('left'),
        },
        'node_modules/scripted': {
          version: '1.0.0',
          resolved: `${registry.url}scripted/-/scripted-1.0.0.tgz`,
          integrity: registry.integrity('scripted'),
          hasInstallScript: true,
        },
      },
    }),
  );
  writeFileSync(
    join(root, '.npmrc'),
    `registry=${registry.url}\n${host}:_authToken=\${REG_TOKEN}\nfetch-retries=0\naudit=false\nfund=false\n`,
  );
}

interface Harness {
  service: ReadinessService;
  data: string;
  storage: Storage;
  workspaceId: WorkspaceId;
  root: string;
  changes: Array<{ run?: InstallRun; report?: ReadinessReport }>;
  waitRun(status: InstallRun['status'][]): Promise<InstallRun>;
}

async function harness(
  options: { cache?: string; home?: string; dir?: string } = {},
): Promise<Harness> {
  const data = options.dir ?? temp('wevir-readiness-data-');
  const home = options.home ?? temp('wevir-readiness-home-');
  const root = temp('wevir-readiness-project-');
  const storage = openStorage({ dataDir: data });
  cleanups.push(() => storage.close());
  const now = new Date().toISOString();
  const workspaceId = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;
  storage.workspaces.insert({
    id: workspaceId,
    rootPath: root,
    displayName: 'demo',
    createdAt: now,
    updatedAt: now,
  });
  const service = new ReadinessService({
    storage,
    secrets: new FileSecretStore(data),
    dir: join(data, 'readiness'),
    defaultEngine: 'echo',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SHELL: '/bin/sh',
      npm_config_cache: options.cache ?? temp('wevir-readiness-cache-'),
      npm_config_update_notifier: 'false',
    },
    home,
  });
  cleanups.push(() => service.dispose());
  await service.recover();
  const changes: Harness['changes'] = [];
  service.watch((change) => changes.push(change));
  const waitRun = async (statuses: InstallRun['status'][]) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const run = [...changes].reverse().find((change) => change.run)?.run;
      if (run && statuses.includes(run.status)) return run;
      if (Date.now() > deadline) throw new Error(`install did not reach ${statuses.join('/')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { service, data, storage, workspaceId, root, changes, waitRun };
}

const plan = (report: ReadinessReport) => report.plans[0] as ReadinessReport['plans'][number];

// 真实的 npm 一次安装在忙的 CI 机器上就要几秒，用例超时与 waitRun 的期限一致。
describe.skipIf(process.platform === 'win32')(
  'ReadinessService 与真实的 npm',
  { timeout: 60_000 },
  () => {
    it('私有仓库认证失败 → 存凭据后装上；postinstall 跑了；令牌不进日志、记录与通知', async () => {
      const registry = await startRegistry();
      const h = await harness();
      writeProject(h.root, registry);

      const before = await h.service.get({ workspaceId: h.workspaceId });
      expect(before.status).toBe('not_ready');
      expect(plan(before)).toMatchObject({
        command: 'npm ci',
        credentials: [{ name: 'REG_TOKEN', source: 'missing' }],
        scripts: { dependencies: 'run' },
      });
      expect(before.network.registries).toContainEqual(
        expect.objectContaining({ url: registry.url, source: '.npmrc', auth: 'missing' }),
      );

      await h.service.install({ workspaceId: h.workspaceId, planId: plan(before).id });
      const failed = await h.waitRun(['failed', 'succeeded']);
      expect(failed).toMatchObject({ status: 'failed', reason: 'registry_auth' });
      const afterFailure = await h.service.get({ workspaceId: h.workspaceId });
      expect(afterFailure.items.find((item) => item.id === 'dependencies::')).toMatchObject({
        status: 'permission',
        reason: 'registry_auth',
      });
      expect(afterFailure.network.advice).toContain('last_install_auth');

      expect(
        await h.service.setCredential({
          workspaceId: h.workspaceId,
          name: 'REG_TOKEN',
          value: TOKEN,
        }),
      ).toEqual({
        credentials: ['REG_TOKEN'],
      });
      const ready = await h.service.get({ workspaceId: h.workspaceId });
      expect(plan(ready).credentials).toEqual([{ name: 'REG_TOKEN', source: 'wevir' }]);
      await h.service.install({ workspaceId: h.workspaceId, planId: plan(ready).id });
      const succeeded = await h.waitRun(['failed', 'succeeded']);
      expect(succeeded.status, succeeded.summary).toBe('succeeded');
      expect(existsSync(join(h.root, 'node_modules', 'left', 'index.js'))).toBe(true);
      expect(existsSync(join(h.root, 'postinstall-ran'))).toBe(true);

      // 装完之后重新预检并通知。
      const deadline = Date.now() + 10_000;
      while (
        !h.changes.some((change) => change.report?.status === 'ready') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(h.changes.some((change) => change.report?.status === 'ready')).toBe(true);
      const output = await h.service.output(succeeded.id);
      expect(output.bytes).toBeGreaterThan(0);
      const files = [
        readFileSync(join(h.data, 'readiness', 'runs.json'), 'utf8'),
        readFileSync(join(h.data, 'readiness', 'logs', `${failed.id}.log`), 'utf8'),
        readFileSync(join(h.data, 'readiness', 'logs', `${succeeded.id}.log`), 'utf8'),
        readFileSync(join(h.data, 'readiness', 'credentials.json'), 'utf8'),
      ];
      expect(`${JSON.stringify(h.changes)}${output.text}${files.join('')}`).not.toContain(TOKEN);
      expect(files[3]).toContain('REG_TOKEN');
    });

    it('有缓存时仓库关掉也装得上；没有缓存时离线是网络失败', async () => {
      const registry = await startRegistry();
      const cache = temp('wevir-readiness-cache-');
      const h = await harness({ cache });
      writeProject(h.root, registry);
      await h.service.setCredential({
        workspaceId: h.workspaceId,
        name: 'REG_TOKEN',
        value: TOKEN,
      });
      const first = await h.service.get({ workspaceId: h.workspaceId });
      await h.service.install({ workspaceId: h.workspaceId, planId: plan(first).id });
      expect((await h.waitRun(['failed', 'succeeded'])).status).toBe('succeeded');

      // 有缓存：删掉依赖、关掉仓库再装。
      rmSync(join(h.root, 'node_modules'), { recursive: true, force: true });
      await registry.close();
      const cached = await h.service.get({ workspaceId: h.workspaceId });
      expect(cached.items.find((item) => item.id === 'dependencies::')?.status).toBe('missing');
      h.changes.length = 0;
      await h.service.install({ workspaceId: h.workspaceId, planId: plan(cached).id });
      const offlineWithCache = await h.waitRun(['failed', 'succeeded']);
      expect(offlineWithCache.status, offlineWithCache.summary).toBe('succeeded');

      // 没有缓存：换一个空的缓存目录（新的 Host 数据目录与项目副本）。
      const fresh = await harness();
      writeProject(fresh.root, registry);
      await fresh.service.setCredential({
        workspaceId: fresh.workspaceId,
        name: 'REG_TOKEN',
        value: TOKEN,
      });
      const offline = await fresh.service.get({ workspaceId: fresh.workspaceId });
      await fresh.service.install({ workspaceId: fresh.workspaceId, planId: plan(offline).id });
      const failed = await fresh.waitRun(['failed', 'succeeded']);
      expect(failed).toMatchObject({ status: 'failed', reason: 'network' });
      const after = await fresh.service.get({ workspaceId: fresh.workspaceId });
      expect(after.items.find((item) => item.id === 'dependencies::')).toMatchObject({
        status: 'network',
        reason: 'last_install_network',
      });
      expect(after.network.advice).toContain('last_install_network');
    });

    it('安装中取消、再重试；同一目录不能同时装；方案过期被拒', async () => {
      const registry = await startRegistry();
      registry.delayMs = 20_000;
      const h = await harness();
      writeProject(h.root, registry);
      await h.service.setCredential({
        workspaceId: h.workspaceId,
        name: 'REG_TOKEN',
        value: TOKEN,
      });
      const report = await h.service.get({ workspaceId: h.workspaceId });
      const run = await h.service.install({ workspaceId: h.workspaceId, planId: plan(report).id });
      expect(run.status).toBe('running');
      await expect(
        h.service.install({ workspaceId: h.workspaceId, planId: plan(report).id }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_IN_USE',
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      h.service.cancel(run.id);
      const cancelled = await h.waitRun(['cancelled', 'failed', 'succeeded']);
      expect(cancelled).toMatchObject({ id: run.id, status: 'cancelled', reason: 'user' });

      registry.delayMs = 0;
      const retry = await h.service.get({ workspaceId: h.workspaceId });
      expect(retry.install?.id).toBe(run.id);
      h.changes.length = 0;
      await h.service.install({ workspaceId: h.workspaceId, planId: plan(retry).id });
      expect((await h.waitRun(['failed', 'succeeded'])).status).toBe('succeeded');

      // 锁文件与清单不一致：方案换成 `npm install`（会写锁文件），旧的方案 ID 被拒。
      const manifest = JSON.parse(readFileSync(join(h.root, 'package.json'), 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      manifest.dependencies = { ...manifest.dependencies, extra: '1.0.0' };
      writeFileSync(join(h.root, 'package.json'), JSON.stringify(manifest));
      const mismatch = await h.service.get({ workspaceId: h.workspaceId });
      expect(mismatch.items.find((item) => item.id === 'lockfile::')).toMatchObject({
        status: 'incompatible',
        reason: 'lockfile_mismatch',
      });
      expect(plan(mismatch)).toMatchObject({ command: 'npm install', writesLockfile: true });
      const error = await h.service
        .install({ workspaceId: h.workspaceId, planId: plan(retry).id })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HostError);
      expect(error).toMatchObject({
        code: 'INVALID_PARAMS',
        data: { issues: [{ path: ['planId'], message: 'plan_changed' }] },
      });
    });

    it('Host 退出时取消进行中的安装；重启后没跑完的记成取消', async () => {
      const registry = await startRegistry();
      registry.delayMs = 20_000;
      const dir = temp('wevir-readiness-data-');
      const h = await harness({ dir });
      writeProject(h.root, registry);
      await h.service.setCredential({
        workspaceId: h.workspaceId,
        name: 'REG_TOKEN',
        value: TOKEN,
      });
      const report = await h.service.get({ workspaceId: h.workspaceId });
      const run = await h.service.install({ workspaceId: h.workspaceId, planId: plan(report).id });
      await h.service.dispose();
      const runs = JSON.parse(
        readFileSync(join(dir, 'readiness', 'runs.json'), 'utf8'),
      ) as InstallRun[];
      expect(runs.find((item) => item.id === run.id)).toMatchObject({
        status: 'cancelled',
        reason: 'host_restarted',
      });

      // 模拟没来得及收尾的 Host：记录里还是 running。
      writeFileSync(
        join(dir, 'readiness', 'runs.json'),
        JSON.stringify([{ ...run, status: 'running' }]),
      );
      const again = new ReadinessService({
        storage: h.storage,
        secrets: new FileSecretStore(dir),
        dir: join(dir, 'readiness'),
        defaultEngine: 'echo',
      });
      expect(await again.recover()).toBe(1);
      const recovered = await again.get({ workspaceId: h.workspaceId });
      expect(recovered.install).toMatchObject({
        id: run.id,
        status: 'cancelled',
        reason: 'host_restarted',
      });
    });
  },
);
