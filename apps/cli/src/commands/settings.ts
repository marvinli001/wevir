import type { WevirClient } from '@wevir/client-sdk';
import { type HostSettings, HostSettingsSchema } from '@wevir/protocol';
import { type Context, requireFeature, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { table } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import { readStdin } from '../prompt.js';

// `wevir settings`：Host 的设置（与桌面端设置页是同一份，host-api.md §3.1 settings.*）。值按设置的类型解析：开关写 on / off，
// 数字写数字，对象写 JSON；Host 按协议校验。`wevir instructions` 是其中的“给 Agent 的说明”（0.78.0）。

const SETTING_KEYS = Object.keys(HostSettingsSchema.shape) as Array<keyof HostSettings>;

function withSettings<T>(ctx: Context, fn: (client: WevirClient) => Promise<T>): Promise<T> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'host_settings');
    return fn(client);
  });
}

function show(value: unknown): string {
  if (value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine === '' ? '""' : oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
  }
  return JSON.stringify(value);
}

/** `wevir settings [list] [--json]`。 */
export async function settingsList(ctx: Context, options: { json?: boolean }): Promise<number> {
  return withSettings(ctx, async (client) => {
    const { settings } = await client.request('settings.get');
    if (options.json) {
      ctx.print(JSON.stringify(settings, null, 2));
      return EXIT.ok;
    }
    const record = settings as Record<string, unknown>;
    ctx.print(
      table(
        [t('settings.col.key'), t('settings.col.value')],
        SETTING_KEYS.map((key) => [key, show(record[key])]),
      ),
    );
    return EXIT.ok;
  });
}

/** 按设置的 schema 解析命令行上的值：先当 JSON，不是 JSON 时当字符串；on / off 等写法当布尔。 */
export function parseSettingValue(key: string, text: string): unknown {
  const schema = HostSettingsSchema.shape[key as keyof HostSettings];
  if (schema === undefined) {
    throw new UsageError(
      t('settings.unknownKey', { key }),
      t('settings.unknownKey.hint', { keys: joinList(SETTING_KEYS) }),
    );
  }
  const lower = text.trim().toLowerCase();
  const candidates: unknown[] = [];
  if (['on', 'true', 'yes', '1'].includes(lower)) candidates.push(true);
  if (['off', 'false', 'no', '0'].includes(lower)) candidates.push(false);
  try {
    candidates.push(JSON.parse(text));
  } catch {
    // 不是 JSON：当字符串。
  }
  candidates.push(text);
  for (const candidate of candidates) {
    if (schema.safeParse(candidate).success) return candidate;
  }
  throw new UsageError(t('settings.badValue', { key, value: text }), t('settings.badValue.hint'));
}

/** `wevir settings set <键> <值>`。 */
export async function settingsSet(ctx: Context, key: string, text: string): Promise<number> {
  const value = parseSettingValue(key, text);
  return withSettings(ctx, async (client) => {
    const { settings } = await client.request('settings.update', {
      settings: { [key]: value } as Partial<HostSettings>,
    });
    ctx.print(
      t('settings.saved', { key, value: show((settings as Record<string, unknown>)[key]) }),
    );
    return EXIT.ok;
  });
}

function requireInstructions(client: WevirClient): void {
  requireFeature(client, 'agent_instructions');
}

/** `wevir instructions [show]`：给所有会话的长期说明。 */
export async function instructionsShow(ctx: Context): Promise<number> {
  return withSettings(ctx, async (client) => {
    requireInstructions(client);
    const { settings } = await client.request('settings.get');
    const text = settings.agentInstructions ?? '';
    ctx.print(text === '' ? t('instructions.none') : text);
    return EXIT.ok;
  });
}

/** `wevir instructions set "<说明>"`；`-` 从 stdin 读到结束。从下一次建会话、恢复或接力起生效。 */
export async function instructionsSet(ctx: Context, words: string[]): Promise<number> {
  const text = words.length === 1 && words[0] === '-' ? await readStdin(ctx.io) : words.join(' ');
  if (text.trim() === '')
    throw new UsageError(t('instructions.empty'), t('instructions.empty.hint'));
  return withSettings(ctx, async (client) => {
    requireInstructions(client);
    const { settings } = await client.request('settings.update', {
      settings: { agentInstructions: text },
    });
    if (settings.agentInstructions !== text) throw new CliError(t('instructions.notSaved'));
    ctx.print(t('instructions.saved', { count: [...text].length }));
    return EXIT.ok;
  });
}

/** `wevir instructions clear`。 */
export async function instructionsClear(ctx: Context): Promise<number> {
  return withSettings(ctx, async (client) => {
    requireInstructions(client);
    await client.request('settings.update', { settings: { agentInstructions: '' } });
    ctx.print(t('instructions.cleared'));
    return EXIT.ok;
  });
}
