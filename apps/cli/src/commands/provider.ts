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
import { PROVIDER_TEST_HINT, PROVIDER_TEST_LABEL, table } from '../format.js';
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

type Kind = ProviderProfile['kind'];

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
          if (problem) throw new UsageError(`--${flag}：${problem}`);
          return given;
        }
        if (!q.interactive) {
          if (fallback !== undefined) return fallback;
          throw new UsageError(
            `缺少 --${flag}`,
            '在终端里交互运行 wevir provider add，或用选项给出各项',
          );
        }
        for (;;) {
          const value = await q.ask(question, fallback);
          const problem = value === '' ? '不能为空' : check(value);
          if (!problem) return value;
          ctx.print(ctx.styles.yellow(problem));
        }
      };

      let kind = flags.kind === undefined ? undefined : parseKind(flags.kind);
      if (flags.kind !== undefined && !kind) {
        throw new UsageError(`--kind 只能是 deepseek-official 或 openai-compatible：${flags.kind}`);
      }
      if (!kind) {
        if (!q.interactive)
          throw new UsageError('缺少 --kind（deepseek-official 或 openai-compatible）');
        kind =
          (await q.choose('Provider 类型：', [
            'DeepSeek 官方（deepseek-official）',
            'OpenAI 兼容地址（通义千问、Kimi、智谱、本机模型服务等）',
          ])) === 0
            ? 'deepseek-official'
            : 'openai-compatible';
      }

      let params: MethodParams<'provider.upsert'>;
      let existing: ProviderProfile | undefined;
      if (kind === 'deepseek-official') {
        existing = providers.find((p) => p.id === DEEPSEEK_ID);
        if (flags.id !== undefined && flags.id !== DEEPSEEK_ID) {
          throw new UsageError(`DeepSeek 官方 Provider 的 ID 固定为 ${DEEPSEEK_ID}`);
        }
        const displayName = await ask(
          'name',
          flags.name,
          '显示名称 ',
          existing?.displayName ?? 'DeepSeek',
        );
        const model = await ask(
          'model',
          flags.model,
          '默认模型（deepseek-flash 或 deepseek-v4-pro）',
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
        const id = await ask(
          'id',
          flags.id,
          'Provider ID（小写字母开头，可含数字与 -；创建后不能改）：',
          undefined,
          (value) => {
            if (!ProviderIdSchema.safeParse(value).success) {
              return '只能用小写字母、数字和 -，以字母开头，最长 32 个字符';
            }
            if (RESERVED_IDS.has(value)) return `${value} 已被 dsh 占用，换一个 ID`;
            return undefined;
          },
        );
        existing = providers.find((p) => p.id === id);
        if (existing && existing.kind !== kind) {
          throw new CliError(`ID ${id} 已被一个 ${existing.kind} 类型的 Provider 使用。`);
        }
        const displayName = await ask('name', flags.name, '显示名称 ', existing?.displayName ?? id);
        const api = (await ask(
          'api',
          flags.api,
          '协议（openai-completions 或 openai-responses）',
          existing?.api ?? 'openai-completions',
          (value) =>
            (APIS as readonly string[]).includes(value) ? undefined : `只能是 ${APIS.join(' 或 ')}`,
        )) as ProviderApi;
        const baseURL = await ask(
          'base-url',
          flags.baseUrl,
          '服务地址（例如 https://api.moonshot.cn/v1）',
          existing?.baseURL,
          checkUrl,
        );
        const model = await ask('model', flags.model, '默认模型 ID ', existing?.defaultModelId);
        const previous = existing?.models.find((m) => m.id === model);
        const contextText =
          flags.contextWindow ??
          (q.interactive
            ? await q.ask('上下文长度（token，可留空）', previous?.contextWindow?.toString())
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
            `API Key（输入不显示${existing?.hasSecret ? '；直接回车保留已存的 Key' : ''}）：`,
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
            `Provider 已保存，但引擎没能用上新配置：${describeError(error).message}`,
            '查看 Host 日志 logs/host.log；改正后再运行一次 wevir provider add',
          );
        }
        throw error;
      }
      const { provider, created } = result;
      ctx.print(
        `${created ? '已添加' : '已更新'} Provider ${provider.id}（${provider.displayName}，默认模型 ${provider.defaultModelId}，Key ${provider.hasSecret ? '已设置' : '未设置'}）`,
      );
      if (!provider.hasSecret) {
        ctx.print(ctx.styles.yellow('还没有设置 Key：需要 Key 的服务会话会因缺少凭据而失败。'));
      }
      ctx.print(ctx.styles.dim(`下一步：wevir provider test ${provider.id}`));
      return EXIT.ok;
    } finally {
      q.close();
    }
  });
}

function checkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只支持 http / https 地址';
    if (url.username || url.password || url.search || url.hash) {
      return '地址不能带用户名、密码、查询参数或 #';
    }
    return undefined;
  } catch {
    return '不是合法的地址';
  }
}

function parseContextWindow(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`上下文长度必须是正整数：${text}`);
  }
  return value;
}

export async function providerList(ctx: Context): Promise<number> {
  const { providers } = await withClient(ctx, (client) => client.request('provider.list'));
  if (providers.length === 0) {
    ctx.print('还没有 Provider。');
    ctx.print(ctx.styles.dim('下一步：wevir provider add'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      ['ID', '名称', '类型', '默认模型', 'Key', '地址'],
      providers.map((p) => [
        p.id,
        p.displayName,
        p.kind,
        p.defaultModelId,
        p.hasSecret ? '已设置' : '未设置',
        p.baseURL ?? '（官方默认）',
      ]),
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
        throw new CliError('还没有 Provider。', '先运行 wevir provider add');
      }
      if (providers.length > 1) {
        throw new UsageError(
          `有 ${providers.length} 个 Provider，指定要测试哪一个：${providers.map((p) => p.id).join('、')}`,
          '例如 wevir provider test <ID>',
        );
      }
      id = (providers[0] as ProviderProfile).id;
    }
    ctx.print(`正在测试 ${id}${options.model ? `（模型 ${options.model}）` : ''}…`);
    const result = await client.request(
      'provider.test',
      { providerId: id, ...(options.model !== undefined && { modelId: options.model }) },
      { timeoutMs: 90_000 },
    );
    if (result.ok) {
      ctx.print(
        ctx.styles.green(
          `✓ 连接正常${result.latencyMs !== undefined ? `，用时 ${result.latencyMs} ms` : ''}`,
        ),
      );
      return EXIT.ok;
    }
    const reason = result.reason ?? 'unknown';
    const status = result.httpStatus !== undefined ? `，HTTP ${result.httpStatus}` : '';
    ctx.print(ctx.styles.red(`✗ 测试失败（${PROVIDER_TEST_LABEL[reason]}${status}）`));
    if (result.error) ctx.print(`  ${result.error.message}`);
    ctx.print(ctx.styles.dim(`下一步：${PROVIDER_TEST_HINT[reason]}`));
    return EXIT.failure;
  });
}
