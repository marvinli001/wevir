import { isRpcError } from '@wevir/client-sdk';
import {
  type MethodParams,
  type ProviderApi,
  ProviderIdSchema,
  type ProviderModel,
  type ProviderProfile,
} from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, describeError, EXIT, UsageError } from '../errors.js';
import { providerTestHint, providerTestLabel, table } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import { Questioner } from '../prompt.js';

export interface ProviderAddFlags {
  kind?: string;
  id?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: string;
  noKey?: boolean;
}

const DEEPSEEK_ID = 'deepseek-official';
/** dsh 里已被其他适配器占用的路由名，`openai-compatible` 不能用（providers.md §2.1）。 */
const RESERVED_IDS = new Set([DEEPSEEK_ID, 'deepseek-account']);
const APIS: readonly ProviderApi[] = ['openai-completions', 'openai-responses'];

/** `provider add` 管的两种；ChatGPT 用 `provider login`，订阅来源（0.19.0）由 Host 按账号建。 */
type Kind = Extract<ProviderProfile['kind'], 'deepseek-official' | 'openai-compatible'>;

function parseKind(value: string): Kind | undefined {
  if (value === 'deepseek-official' || value === 'deepseek') return 'deepseek-official';
  if (value === 'openai-compatible' || value === 'openai') return 'openai-compatible';
  return undefined;
}

/**
 * `wevir provider add`：添加或更新一个 Provider。没给的选项在终端里逐项询问；Key 只在终端里不回显地
 * 输入（或从管道读一行），不接受命令行参数，不会进 shell 历史。
 */
export async function providerAdd(ctx: Context, flags: ProviderAddFlags): Promise<number> {
  return withClient(ctx, async (client) => {
    const { providers } = await client.request('provider.list');
    const q = new Questioner(ctx.io);
    try {
      const ask = async (
        flag: string,
        given: string | undefined,
        question: string,
        fallback: string | undefined,
        check: (value: string) => string | undefined = () => undefined,
      ): Promise<string> => {
        if (given !== undefined) {
          const problem = check(given);
          if (problem) throw new UsageError(t('provider.flagProblem', { flag, problem }));
          return given;
        }
        if (!q.interactive) {
          if (fallback !== undefined) return fallback;
          throw new UsageError(t('provider.missingFlag', { flag }), t('provider.missingFlag.hint'));
        }
        for (;;) {
          const value = await q.ask(question, fallback);
          const problem = value === '' ? t('provider.empty') : check(value);
          if (!problem) return value;
          ctx.print(ctx.styles.yellow(problem));
        }
      };

      if (flags.kind === 'chatgpt') {
        throw new UsageError(t('provider.chatgpt'), t('provider.chatgpt.hint'));
      }
      let kind = flags.kind === undefined ? undefined : parseKind(flags.kind);
      if (flags.kind !== undefined && !kind) {
        throw new UsageError(t('provider.badKind', { kind: flags.kind }));
      }
      if (!kind) {
        if (!q.interactive) throw new UsageError(t('provider.missingKind'));
        kind =
          (await q.choose(t('provider.kindQuestion'), [
            t('provider.kind.deepseek'),
            t('provider.kind.compatible'),
          ])) === 0
            ? 'deepseek-official'
            : 'openai-compatible';
      }

      let params: Exclude<MethodParams<'provider.upsert'>, { kind: 'chatgpt' }>;
      let existing: ProviderProfile | undefined;
      if (kind === 'deepseek-official') {
        existing = providers.find((p) => p.id === DEEPSEEK_ID);
        if (flags.id !== undefined && flags.id !== DEEPSEEK_ID) {
          throw new UsageError(t('provider.fixedId', { id: DEEPSEEK_ID }));
        }
        const displayName = await ask(
          'name',
          flags.name,
          t('provider.ask.name'),
          existing?.displayName ?? 'DeepSeek',
        );
        const model = await ask(
          'model',
          flags.model,
          t('provider.ask.deepseekModel'),
          existing?.defaultModelId ?? 'deepseek-flash',
        );
        params = {
          id: DEEPSEEK_ID,
          kind,
          displayName,
          models: existing?.models ?? [],
          defaultModelId: model,
          ...(flags.baseUrl !== undefined
            ? { baseURL: flags.baseUrl }
            : existing?.baseURL !== undefined && { baseURL: existing.baseURL }),
        };
      } else {
        const id = await ask('id', flags.id, t('provider.ask.id'), undefined, (value) => {
          if (!ProviderIdSchema.safeParse(value).success) {
            return t('provider.badId');
          }
          if (RESERVED_IDS.has(value)) return t('provider.reservedId', { id: value });
          return undefined;
        });
        existing = providers.find((p) => p.id === id);
        if (existing && existing.kind !== kind) {
          throw new CliError(t('provider.idTaken', { id, kind: existing.kind }));
        }
        const displayName = await ask(
          'name',
          flags.name,
          t('provider.ask.name'),
          existing?.displayName ?? id,
        );
        const api = (await ask(
          'api',
          flags.api,
          t('provider.ask.api'),
          existing?.api ?? 'openai-completions',
          (value) =>
            (APIS as readonly string[]).includes(value) ? undefined : t('provider.badApi'),
        )) as ProviderApi;
        const baseURL = await ask(
          'base-url',
          flags.baseUrl,
          t('provider.ask.baseUrl'),
          existing?.baseURL,
          checkUrl,
        );
        const model = await ask(
          'model',
          flags.model,
          t('provider.ask.model'),
          existing?.defaultModelId,
        );
        const previous = existing?.models.find((m) => m.id === model);
        const contextText =
          flags.contextWindow ??
          (q.interactive
            ? await q.ask(t('provider.ask.contextWindow'), previous?.contextWindow?.toString())
            : undefined);
        const contextWindow = parseContextWindow(contextText);
        const entry: ProviderModel = {
          ...previous,
          id: model,
          ...(contextWindow !== undefined && { contextWindow }),
        };
        const others = existing?.models.filter((m) => m.id !== model) ?? [];
        params = {
          id,
          kind,
          displayName,
          api,
          baseURL,
          models: [entry, ...others],
          defaultModelId: model,
          ...(existing?.compat !== undefined && { compat: existing.compat }),
        };
      }

      if (!flags.noKey) {
        let key: string | undefined;
        if (q.interactive) {
          key = await q.askSecret(
            existing?.hasSecret ? t('provider.ask.keyKeep') : t('provider.ask.key'),
          );
        } else {
          key = (await q.readLine())?.trim();
        }
        if (key) params.apiKey = key;
      }
      q.close();

      let result: { provider: ProviderProfile; created: boolean };
      try {
        result = await client.request('provider.upsert', params);
      } catch (error) {
        if (isRpcError(error, 'ENGINE_ERROR')) {
          throw new CliError(
            t('provider.engineFailed', { error: describeError(error).message }),
            t('provider.engineFailed.hint'),
          );
        }
        throw error;
      }
      const { provider, created } = result;
      const summary = {
        id: provider.id,
        name: provider.displayName,
        model: provider.defaultModelId,
        key: provider.hasSecret ? t('provider.key.set') : t('provider.key.unset'),
      };
      ctx.print(created ? t('provider.added', summary) : t('provider.updated', summary));
      if (!provider.hasSecret) ctx.print(ctx.styles.yellow(t('provider.noKeyWarning')));
      ctx.print(ctx.styles.dim(t('error.hint', { hint: `wevir provider test ${provider.id}` })));
      return EXIT.ok;
    } finally {
      q.close();
    }
  });
}

function checkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return t('provider.url.scheme');
    if (url.username || url.password || url.search || url.hash) {
      return t('provider.url.extras');
    }
    return undefined;
  } catch {
    return t('provider.url.invalid');
  }
}

function parseContextWindow(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(t('provider.badContextWindow', { text }));
  }
  return value;
}

export async function providerList(ctx: Context): Promise<number> {
  const { providers } = await withClient(ctx, (client) => client.request('provider.list'));
  if (providers.length === 0) {
    ctx.print(t('provider.none'));
    ctx.print(ctx.styles.dim(t('error.hint', { hint: t('provider.none.hint') })));
    return EXIT.ok;
  }
  ctx.print(
    table(
      [
        'ID',
        t('provider.col.name'),
        t('provider.col.kind'),
        t('provider.col.model'),
        'Key',
        t('provider.col.address'),
      ],
      providers.map((p) =>
        p.kind === 'chatgpt'
          ? [
              p.id,
              p.displayName,
              p.kind,
              p.defaultModelId,
              t('provider.chatgptLogin'),
              t('common.paren', { text: 'ChatGPT' }),
            ]
          : p.kind !== 'deepseek-official' && p.kind !== 'openai-compatible'
            ? [
                p.id,
                p.displayName,
                p.kind,
                p.defaultModelId,
                t('provider.subscriptionLogin'),
                t('common.paren', { text: p.displayName }),
              ]
            : [
                p.id,
                p.displayName,
                p.kind,
                p.defaultModelId,
                p.hasSecret ? t('provider.key.set') : t('provider.key.unset'),
                p.baseURL ?? t('provider.officialAddress'),
              ],
      ),
    ),
  );
  return EXIT.ok;
}

export async function providerTest(
  ctx: Context,
  providerId: string | undefined,
  options: { model?: string },
): Promise<number> {
  return withClient(ctx, async (client) => {
    let id = providerId;
    if (id === undefined) {
      const { providers } = await client.request('provider.list');
      if (providers.length === 0) {
        throw new CliError(t('provider.none'), t('session.noProviders.hint'));
      }
      if (providers.length > 1) {
        throw new UsageError(
          t('provider.manyToTest', {
            count: providers.length,
            ids: joinList(providers.map((p) => p.id)),
          }),
          t('provider.manyToTest.hint'),
        );
      }
      id = (providers[0] as ProviderProfile).id;
    }
    ctx.print(
      options.model
        ? t('provider.testingModel', { id, model: options.model })
        : t('provider.testing', { id }),
    );
    const result = await client.request(
      'provider.test',
      { providerId: id, ...(options.model !== undefined && { modelId: options.model }) },
      { timeoutMs: 90_000 },
    );
    if (result.ok) {
      ctx.print(
        ctx.styles.green(
          result.latencyMs !== undefined
            ? t('provider.testOkLatency', { ms: result.latencyMs })
            : t('provider.testOk'),
        ),
      );
      return EXIT.ok;
    }
    const reason = result.reason ?? 'unknown';
    const label = providerTestLabel(reason);
    ctx.print(
      ctx.styles.red(
        result.httpStatus !== undefined
          ? t('provider.testFailedHttp', { reason: label, status: result.httpStatus })
          : t('provider.testFailed', { reason: label }),
      ),
    );
    if (result.error) ctx.print(`  ${result.error.message}`);
    ctx.print(ctx.styles.dim(t('error.hint', { hint: providerTestHint(reason) })));
    return EXIT.failure;
  });
}
