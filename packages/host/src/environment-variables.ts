// 环境变量（0.130.0，domain-model §3.10）：值只进 SecretStore（ADR-0003），键是 `environment:<环境 ID>:variables`，内容是按填写顺序的
// `[名字, 值]` 列表的 JSON；线缆上只给名字与打码后的样子。建立、恢复与分出环境的会话时，Host 现读一次交给引擎（`SessionConfig.env`）。

import type { EnvironmentVariable, EnvironmentVariableInput } from '@wevir/protocol';
import type { SecretStore } from '@wevir/storage';
import { HostError } from './errors.js';

export type VariableEntries = readonly (readonly [name: string, value: string])[];

/** Host 自己用的前缀：模型跑的命令本来就看不到它们（Codex 的 `shell_environment_policy.exclude`），也不让用户设。 */
const RESERVED_PREFIX = 'WEVIR_';

export function variablesRef(environmentId: string): string {
  return `environment:${environmentId}:variables`;
}

export async function readVariables(
  secrets: SecretStore,
  environmentId: string,
): Promise<VariableEntries> {
  const raw = await secrets.get(variablesRef(environmentId));
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
    );
  } catch {
    return [];
  }
}

/** 整组写入；空列表时删掉这一项。 */
export async function writeVariables(
  secrets: SecretStore,
  environmentId: string,
  entries: VariableEntries,
): Promise<void> {
  if (entries.length === 0) {
    await secrets.delete(variablesRef(environmentId));
    return;
  }
  await secrets.set(variablesRef(environmentId), JSON.stringify(entries));
}

/**
 * 请求里的变量 → 要存的列表。没给值的沿用 `current` 里的同名变量（客户端没改的那几行）。名字重复、用了保留前缀、没给值又没有
 * 同名的旧值时回 `INVALID_PARAMS`。
 */
export function resolveVariables(
  inputs: readonly EnvironmentVariableInput[],
  current: VariableEntries,
): VariableEntries {
  const stored = new Map(current);
  const seen = new Set<string>();
  return inputs.map(({ name, value }, index) => {
    const path = ['variables', index, 'name'];
    if (seen.has(name)) throw invalidParams(path, `variable ${name} is listed twice`);
    seen.add(name);
    if (name.toUpperCase().startsWith(RESERVED_PREFIX)) {
      throw invalidParams(path, `variable names starting with ${RESERVED_PREFIX} are reserved`);
    }
    const resolved = value ?? stored.get(name);
    if (resolved === undefined) {
      throw invalidParams(['variables', index, 'value'], `variable ${name} has no value`);
    }
    return [name, resolved] as const;
  });
}

function invalidParams(path: (string | number)[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

/** 打码：20 字以上的留前 10 与后 4 字（`sk_test_51...gGGa`），短的整段换成圆点，空值不变。 */
export function previewOf(value: string): string {
  if (value.length === 0) return '';
  const chars = [...value];
  if (chars.length < 20) return '••••••••';
  return `${chars.slice(0, 10).join('')}...${chars.slice(-4).join('')}`;
}

export function toVariables(entries: VariableEntries): EnvironmentVariable[] {
  return entries.map(([name, value]) => ({ name, preview: previewOf(value) }));
}
