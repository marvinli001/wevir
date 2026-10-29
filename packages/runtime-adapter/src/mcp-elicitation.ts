// MCP 服务向用户要输入（elicitation，MCP 2025-11-25 起的 `elicitation/create`）映射到 Wevir 已有的提问与审批：引擎的
// MCP 客户端把用户接入的连接器发来的请求转给适配器（Codex：`mcpServer/elicitation/request`；Claude：`onElicitation`；ACP：
// `elicitation/create`），适配器用这里的函数换成 `question.requested` 或 `approval.requested`，再把用户的回答换回 MCP 的结果。
//
// - 表单（`form`）：每个字段一个问题，问题 ID 是字段名。枚举与布尔给选项（多选枚举 `multiSelect`），字符串与数字只能自己填写
//   （`allowOther`）。回答按字段的类型换回去：选项的标签换回枚举值，数字要能解析；全部跳过是 `decline`，必填的字段没答或答得不对
//   也是 `decline`（服务拿不到能用的结果）。
// - 链接（`url`）：一个“打开链接”的审批。适配器先报一次 `tool.started`（工具名 `MCP_URL_ELICITATION_TOOL`、展示类型 `fetch`，
//   `url` 与 `mcpServer` 是请求里的），审批详情由 Host 从它取；用户允许时由客户端在浏览器里打开这个地址，适配器回 `accept`，拒绝回
//   `decline`。只认 http 与 https 的地址，别的一律 `decline`。服务确认完成（Claude 的 `elicitation_complete`、ACP 的
//   `elicitation/complete`）或请求结束时，适配器报这个工具调用的 `tool.finished`。

import type { ApprovalOption, ToolDisplay, UserQuestion } from './types.js';

/**
 * 链接类 elicitation 的工具名（同 @wevir/protocol 的 `MCP_URL_ELICITATION_TOOL`）：不是合法的 MCP 工具名（有 `/`），不会与连接器的
 * 工具撞名。客户端认出它的审批，允许时打开 `display.url`。
 */
export const MCP_URL_ELICITATION_TOOL = 'mcp/elicitation/url';

/** 链接类 elicitation 的审批选项：允许（打开）与拒绝。 */
export const URL_ELICITATION_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'accept', label: '打开', kind: 'allow_accept' },
  { optionId: 'decline', label: '拒绝', kind: 'reject_decline' },
]);

/** 回给 MCP 服务的结果（MCP 的 `ElicitResult`）。 */
export type ElicitationResult =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** 布尔字段的两个选项。 */
const YES = 'Yes';
const NO = 'No';

interface Field {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi';
  required: boolean;
  /** 枚举：选项标签 → 值。 */
  values?: Map<string, string>;
  question: UserQuestion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 枚举的选项：`oneOf` / `anyOf` 的 `{const, title}`，或 `enum`（旧写法的 `enumNames` 是标签）。 */
function enumValues(schema: Record<string, unknown>): Map<string, string> | undefined {
  const titled = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : isRecord(schema.items) && Array.isArray(schema.items.anyOf)
      ? schema.items.anyOf
      : undefined;
  if (titled !== undefined) {
    const values = new Map<string, string>();
    for (const option of titled) {
      if (!isRecord(option) || typeof option.const !== 'string') return undefined;
      values.set(text(option.title) ?? option.const, option.const);
    }
    return values.size > 0 ? values : undefined;
  }
  const plain = Array.isArray(schema.enum)
    ? schema.enum
    : isRecord(schema.items) && Array.isArray(schema.items.enum)
      ? schema.items.enum
      : undefined;
  if (plain === undefined || !plain.every((value) => typeof value === 'string')) return undefined;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  const values = new Map<string, string>();
  plain.forEach((value, index) => {
    values.set(text(names[index]) ?? (value as string), value as string);
  });
  return values.size > 0 ? values : undefined;
}

function fieldsOf(message: string, requestedSchema: unknown): Field[] | undefined {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return undefined;
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const fields: Field[] = [];
  for (const [key, schema] of Object.entries(requestedSchema.properties)) {
    if (!isRecord(schema)) return undefined;
    const title = text(schema.title);
    const description = text(schema.description);
    const base = {
      id: key,
      ...(title !== undefined && { header: title }),
      question: description ?? title ?? key,
    };
    const values =
      schema.type === 'string' || schema.type === 'array' ? enumValues(schema) : undefined;
    let field: Field;
    if (values !== undefined) {
      const labels = [...values.keys()];
      const fallback =
        typeof schema.default === 'string'
          ? labels.find((label) => values.get(label) === schema.default)
          : undefined;
      field = {
        key,
        type: schema.type === 'array' ? 'multi' : 'enum',
        required: required.has(key),
        values,
        question: {
          ...base,
          options: labels.map((label) => ({ label })),
          ...(schema.type === 'array' && { multiSelect: true }),
          ...(fallback !== undefined && { defaultOption: fallback }),
        },
      };
    } else if (schema.type === 'boolean') {
      field = {
        key,
        type: 'boolean',
        required: required.has(key),
        question: {
          ...base,
          options: [{ label: YES }, { label: NO }],
          ...(typeof schema.default === 'boolean' && { defaultOption: schema.default ? YES : NO }),
        },
      };
    } else if (schema.type === 'string' || schema.type === 'number' || schema.type === 'integer') {
      field = {
        key,
        type: schema.type,
        required: required.has(key),
        question: { ...base, options: [], allowOther: true },
      };
    } else {
      return undefined;
    }
    fields.push(field);
  }
  // 服务的说明放在第一个问题前面（没有字段的表单只是一句确认，换成一个是 / 否的问题）。
  const intro = text(message);
  const [first] = fields;
  if (first === undefined) {
    return [
      {
        key: '',
        type: 'boolean',
        required: true,
        question: {
          id: 'confirm',
          question: intro ?? 'Continue?',
          options: [{ label: YES }, { label: NO }],
        },
      },
    ];
  }
  if (intro !== undefined) first.question.question = `${intro}\n\n${first.question.question}`;
  return fields;
}

/**
 * 表单 elicitation 的问题。字段类型不认识（嵌套对象等，MCP 只许平铺的基本类型）时返回 `undefined`，适配器回 `decline`。
 */
export function elicitationQuestions(
  message: string,
  requestedSchema: unknown,
): UserQuestion[] | undefined {
  return fieldsOf(message, requestedSchema)?.map((field) => field.question);
}

/** 用户的回答换回表单 elicitation 的结果（`answers` 按问题 ID，同 `respondToQuestion`）。 */
export function elicitationResult(
  message: string,
  requestedSchema: unknown,
  answers: Record<string, readonly string[]>,
): ElicitationResult {
  const fields = fieldsOf(message, requestedSchema);
  if (fields === undefined) return { action: 'decline' };
  const answered = (field: Field) =>
    (answers[field.question.id] ?? [])
      .map((answer) => answer.trim())
      .filter((answer) => answer !== '');
  if (fields.every((field) => answered(field).length === 0)) return { action: 'decline' };
  // 没有字段的表单：答“是”就是 accept（空的内容）。
  if (fields.length === 1 && fields[0]?.key === '') {
    return answered(fields[0])[0] === YES
      ? { action: 'accept', content: {} }
      : { action: 'decline' };
  }
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of fields) {
    const given = answered(field);
    const value = convert(field, given);
    if (value === undefined) {
      if (field.required) return { action: 'decline' };
      continue;
    }
    content[field.key] = value;
  }
  return { action: 'accept', content };
}

function convert(field: Field, given: string[]): string | number | boolean | string[] | undefined {
  const [first] = given;
  if (first === undefined) return undefined;
  switch (field.type) {
    case 'string':
      return first;
    case 'number':
    case 'integer': {
      const value = Number(first);
      if (!Number.isFinite(value)) return undefined;
      if (field.type === 'integer' && !Number.isInteger(value)) return undefined;
      return value;
    }
    case 'boolean':
      return first === YES ? true : first === NO ? false : undefined;
    case 'enum':
      return (
        field.values?.get(first) ?? [...(field.values?.values() ?? [])].find((v) => v === first)
      );
    case 'multi': {
      const values = given.map(
        (label) =>
          field.values?.get(label) ?? [...(field.values?.values() ?? [])].find((v) => v === label),
      );
      return values.every((value): value is string => value !== undefined) ? values : undefined;
    }
  }
}

/** 链接类 elicitation 的地址能不能给用户打开：只认 http 与 https。 */
export function elicitationUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** 链接类 elicitation 的 `tool.started` 的展示：`fetch`，摘要是地址。 */
export function elicitationUrlDisplay(server: string, url: string): ToolDisplay {
  return { kind: 'fetch', summary: url, url, mcpServer: server };
}
