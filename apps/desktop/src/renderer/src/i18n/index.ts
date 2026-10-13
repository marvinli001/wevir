// 文案模块（T5.2）：t(key, params) 从当前语言的目录取文案并替换 `{name}` 参数。现在只有源语言简体中文；
// 以后接 i18n 库时保留 key 与 `{name}` 写法，只换这里的实现。

import { type MessageKey, type Messages, zhCN } from './zh-CN.js';

export type { MessageKey } from './zh-CN.js';

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** 某条文案需要的参数；没有占位符的文案不接受参数。 */
export type MessageParams<K extends MessageKey> = Record<
  Placeholders<(typeof zhCN)[K]>,
  string | number
>;

/** 没有占位符的文案 key：按变量取 key 时（标签表等）用它，t() 不需要参数。 */
export type PlainMessageKey = {
  [K in MessageKey]: [Placeholders<(typeof zhCN)[K]>] extends [never] ? K : never;
}[MessageKey];

type ParamsArg<K extends MessageKey> = [Placeholders<(typeof zhCN)[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

const messages: Messages = zhCN;

export function t<K extends MessageKey>(key: K, ...[params]: ParamsArg<K>): string {
  const template = messages[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String((params as Record<string, string | number>)[name]) : match,
  );
}
