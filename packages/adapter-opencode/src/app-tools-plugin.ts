// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/server/src/server/agent/providers/opencode/bridge-plugin.mjs（`paseoPlugin`、`formatToolResult`、
// `jsonSchemaObjectToZodShape`、`jsonSchemaToZod`、`unionToZod`）
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra
// 由 Wevir 修改：成了一段生成出来的源码；工具定义与调用走 Host 的 `wevir` MCP 端点（JSON-RPC 的 tools/list、tools/call，带引擎
// 令牌与引擎会话 ID 的请求头），不另开桥；只读的工具与 wevir_show 不经 `context.ask`；工具报错（`isError`）时抛错；列不出工具时
// 不挂工具、不让插件加载失败；分发工具（wevir_call_readonly / wevir_call）按目标工具问权限；去掉 shell.env 与按父会话找上下文（Wevir 的子会话有自己的记录）；zod 按绝对地址 import Wevir 装的
// 那份；请求带上 opencode 的中止信号。
//
// OpenCode 的应用级工具插件（opencode-event-mapping.md §4.4）。要不要问用户交给 opencode 自己的权限系统（`context.ask`，权限名是
// 工具名）：on_request 的规则集里 `*` 是 ask，完全访问是 allow。

import {
  APP_TOOLS_CALL,
  APP_TOOLS_CALL_READONLY,
  APP_TOOLS_ENGINE_SESSION_HEADER,
} from '@wevir/runtime-adapter';

/**
 * 插件源码。opencode 1.x 的插件工具参数要是 zod 的 shape（1.14.49 起也接受 JSON Schema，但会把每个参数都当成必填），所以把 Host
 * 给的 JSON Schema 转成 zod；zod 按 `zodUrl` 这个绝对地址 import（插件在 Wevir 的数据目录里，按包名解析不到）。只导出一个默认
 * 函数：opencode 把模块导出的每个函数都当成插件。
 */
export function appToolsPluginSource(zodUrl: string): string {
  return `// 由 Wevir 生成（packages/adapter-opencode/src/app-tools.ts），内容变了换文件名，不要手改。
// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo（https://github.com/getpaseo/paseo）的 bridge-plugin.mjs，Copyright (c) 2025-present Mohamed Boudra，由 Wevir 修改。
import { z } from ${JSON.stringify(zodUrl)};

const SESSION_HEADER = ${JSON.stringify(APP_TOOLS_ENGINE_SESSION_HEADER)};
const DISPATCH = new Set(${JSON.stringify([APP_TOOLS_CALL_READONLY, APP_TOOLS_CALL])});

export default async function wevirAppTools(_input, options) {
  const url = options?.url;
  const token = options?.token;
  if (typeof url !== 'string' || typeof token !== 'string') return {};
  const noApproval = new Set(Array.isArray(options.noApproval) ? options.noApproval : []);
  let nextId = 1;
  const rpc = async (method, params, sessionID, signal) => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + token,
    };
    if (sessionID !== undefined) headers[SESSION_HEADER] = sessionID;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal,
    });
    if (response.status === 404) throw new Error('This OpenCode session does not belong to Wevir.');
    if (!response.ok) throw new Error('Wevir app tools: HTTP ' + response.status);
    const reply = await response.json();
    if (reply?.error) throw new Error(reply.error.message || 'Wevir app tools failed');
    return reply?.result ?? {};
  };

  let listed;
  try {
    listed = await rpc('tools/list', {});
  } catch (error) {
    console.error('[wevir-app-tools] could not list the Wevir tools:', error instanceof Error ? error.message : String(error));
    return {};
  }
  const tool = {};
  for (const definition of Array.isArray(listed.tools) ? listed.tools : []) {
    const name = definition?.name;
    if (typeof name !== 'string') continue;
    tool[name] = {
      description: typeof definition.description === 'string' ? definition.description : name,
      args: objectShape(definition.inputSchema),
      async execute(args, context) {
        // 分发工具按目标工具问：模式是目标的名字，“总是允许”只放行那一个工具；不用批准的目标照样不问。
        const target = DISPATCH.has(name) && typeof args?.name === 'string' ? args.name : undefined;
        if (!noApproval.has(target ?? name)) {
          // opencode 把插件工具的权限交给插件自己：照它问 MCP 工具的方式问，权限名就是工具名。
          const patterns = [target ?? '*'];
          await context.ask({ permission: name, patterns, always: patterns, metadata: args ?? {} });
        }
        const result = await rpc('tools/call', { name, arguments: args ?? {} }, context.sessionID, context.abort);
        const text = resultText(result);
        if (result.isError === true) throw new Error(text || name + ' failed');
        return { title: typeof definition.title === 'string' ? definition.title : name, output: text, metadata: {} };
      },
    };
  }
  return { tool };
}

function resultText(result) {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : null))
    .filter((part) => part !== null)
    .join('\\n');
  return text || JSON.stringify(result.structuredContent ?? result.content ?? {});
}

function objectShape(schema) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const shape = {};
  for (const [key, property] of Object.entries(properties)) {
    const parsed = toZod(property);
    shape[key] = required.has(key) ? parsed : parsed.optional();
  }
  return shape;
}

function toZod(schema) {
  if (!schema || typeof schema !== 'object') return z.any();
  if (Array.isArray(schema.anyOf)) return union(schema.anyOf);
  if (Array.isArray(schema.oneOf)) return union(schema.oneOf);
  if (schema.const !== undefined) return z.literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length === 1) return z.literal(schema.enum[0]);
    if (schema.enum.every((item) => typeof item === 'string')) return z.enum(schema.enum);
    return z.union(schema.enum.map((item) => z.literal(item)));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const type = types.find((item) => item !== 'null');
  let result;
  switch (type) {
    case 'string':
      result = z.string();
      break;
    case 'integer':
      result = z.number().int();
      break;
    case 'number':
      result = z.number();
      break;
    case 'boolean':
      result = z.boolean();
      break;
    case 'array':
      result = z.array(toZod(schema.items));
      break;
    case 'object':
      result = z.object(objectShape(schema));
      break;
    default:
      result = z.any();
  }
  if (typeof schema.description === 'string') result = result.describe(schema.description);
  return nullable ? result.nullable() : result;
}

function union(items) {
  const nonNull = items.filter((item) => item?.type !== 'null');
  const parsed = nonNull.map(toZod);
  let result;
  if (parsed.length === 0) result = z.null();
  else if (parsed.length === 1) result = parsed[0];
  else result = z.union(parsed);
  return nonNull.length !== items.length ? result.nullable() : result;
}
`;
}
