import type { WebSettings, WebTestFailure } from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { table } from '../format.js';
import { joinList, type PlainMessageKey, t } from '../i18n/index.js';
import { Questioner } from '../prompt.js';

// `wevir web`（0.34.0，docs/architecture/web-tools.md）：Agent 联网工具的设置，与桌面端的“设置 → 联网搜索”是同一份（存在 Host）。
// Key 只在终端里不回显地输入（或从管道读一行），不接受命令行参数。

const SERVICE_NAMES: Readonly<Record<string, PlainMessageKey>> = {
  bocha: 'web.service.bocha',
  tavily: 'web.service.tavily',
};

const serviceName = (id: string): string => {
  const key = SERVICE_NAMES[id];
  return key === undefined ? id : t(key);
};

const REASONS: Record<WebTestFailure, PlainMessageKey> = {
  missing_key: 'providerTest.missing_key',
  auth: 'providerTest.auth',
  quota: 'web.reason.quota',
  rate_limited: 'providerTest.rate_limited',
  network: 'providerTest.network',
  timeout: 'providerTest.timeout',
  server: 'providerTest.server',
  invalid_response: 'web.reason.invalid_response',
  unknown: 'providerTest.unknown',
};

/** 服务 ID 要是 Host 支持的一个；不给时用当前选中的。 */
function pickService(web: WebSettings, given: string | undefined): string {
  if (given === undefined) return web.searchService;
  const id = given.toLowerCase();
  if (!web.services.some((service) => service.id === id)) {
    throw new UsageError(
      t('web.unknownService', { service: given }),
      t('web.unknownService.hint', { services: joinList(web.services.map((s) => s.id)) }),
    );
  }
  return id;
}

function printStatus(ctx: Context, web: WebSettings): void {
  ctx.print(t(web.enabled ? 'web.status.on' : 'web.status.off'));
  ctx.print(
    table(
      [t('web.col.service'), t('web.col.key'), ''],
      web.services.map((service) => [
        `${serviceName(service.id)} (${service.id})`,
        service.hasKey ? t('web.key.set') : t('web.key.missing'),
        service.id === web.searchService ? t('web.current') : '',
      ]),
    ),
  );
}

/** `wevir web status`。 */
export function webStatus(ctx: Context): Promise<number> {
  return withClient(ctx, async (client) => {
    const { web } = await client.request('web.get');
    printStatus(ctx, web);
    return EXIT.ok;
  });
}

/** `wevir web on` / `wevir web off`。 */
export function webEnable(ctx: Context, enabled: boolean): Promise<number> {
  return withClient(ctx, async (client) => {
    const { web } = await client.request('web.update', { enabled });
    printStatus(ctx, web);
    return EXIT.ok;
  });
}

/** `wevir web use <服务>`。 */
export function webUse(ctx: Context, service: string): Promise<number> {
  return withClient(ctx, async (client) => {
    const current = await client.request('web.get');
    const id = pickService(current.web, service);
    const { web } = await client.request('web.update', { searchService: id });
    printStatus(ctx, web);
    if (web.services.find((entry) => entry.id === id)?.hasKey !== true) {
      ctx.print(ctx.styles.yellow(t('web.noKeyYet', { service: id })));
    }
    return EXIT.ok;
  });
}

/** `wevir web key [<服务>] [--remove]`：不回显地读 Key 存进 Host，或删掉。 */
export function webKey(
  ctx: Context,
  service: string | undefined,
  options: { remove?: boolean },
): Promise<number> {
  return withClient(ctx, async (client) => {
    const { web: current } = await client.request('web.get');
    const id = pickService(current, service);
    if (options.remove === true) {
      await client.request('web.update', { key: { service: id, apiKey: null } });
      ctx.print(t('web.keyRemoved', { service: serviceName(id) }));
      return EXIT.ok;
    }
    const q = new Questioner(ctx.io);
    let key: string;
    try {
      key = await q.askSecret(t('web.keyPrompt', { service: serviceName(id) }));
    } finally {
      q.close();
    }
    if (key === '') throw new CliError(t('web.keyEmpty'));
    await client.request('web.update', { key: { service: id, apiKey: key } });
    ctx.print(ctx.styles.green(t('web.keySaved', { service: serviceName(id) })));
    ctx.print(ctx.styles.dim(t('web.keySaved.hint', { service: id })));
    return EXIT.ok;
  });
}

/** `wevir web test [<服务>]`：用存着的 Key 做一次真实的搜索。 */
export function webTest(ctx: Context, service: string | undefined): Promise<number> {
  return withClient(ctx, async (client) => {
    const { web } = await client.request('web.get');
    const id = pickService(web, service);
    ctx.print(t('web.testing', { service: serviceName(id) }));
    const result = await client.request('web.test', { service: id }, { timeoutMs: 60_000 });
    if (result.ok) {
      ctx.print(ctx.styles.green(t('provider.testOkLatency', { ms: result.latencyMs ?? 0 })));
      return EXIT.ok;
    }
    const label = t(REASONS[result.reason ?? 'unknown']);
    ctx.print(
      ctx.styles.red(
        result.httpStatus !== undefined
          ? t('provider.testFailedHttp', { reason: label, status: result.httpStatus })
          : t('provider.testFailed', { reason: label }),
      ),
    );
    if (result.message) ctx.print(`  ${result.message}`);
    if (result.reason === 'missing_key') {
      ctx.print(ctx.styles.dim(t('error.hint', { hint: t('web.noKeyYet', { service: id }) })));
    }
    return EXIT.failure;
  });
}
