// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP_TOOLS_CALL,
  APP_TOOLS_CALL_READONLY,
  APP_TOOLS_ENGINE_SESSION_HEADER,
  type AppToolsEndpoint,
} from '@wevir/runtime-adapter';
import {
  APP_TOOLS_LIST_TIMEOUT_MS,
  appToolsPluginEntry,
  isAppToolsPlugin,
  PLUGIN_DIRECTORY,
} from './app-tools.js';

const V2_PLUGIN_PREFIX = 'wevir-v2-app-tools-';

export interface OpenCodeV2PluginEntry {
  package: string;
  options: Record<string, unknown>;
}

export function writeV2AppToolsPlugin(engineDir: string): string {
  const source = v2AppToolsSource();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = path.join(engineDir, PLUGIN_DIRECTORY, `${V2_PLUGIN_PREFIX}${hash}`);
  const file = path.join(dir, 'index.js');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, source, { mode: 0o600 });
    renameSync(temp, file);
  }
  return pathToFileURL(dir).href;
}

export function v2AppToolsPluginEntry(
  pluginUrl: string,
  endpoint: AppToolsEndpoint,
): OpenCodeV2PluginEntry {
  const [, options] = appToolsPluginEntry(pluginUrl, endpoint);
  return { package: pluginUrl, options };
}

const SERVER_RULES = [
  'shell',
  'edit',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
].map((action) => ({ action, resource: '*', effect: 'ask' }));

/** V2 normalizes legacy config keys before applying the native ones. */
export function v2ServerConfigContent(
  existing: string | undefined,
  plugin?: OpenCodeV2PluginEntry,
): string {
  const config = readConfig(existing);
  const plugins = Array.isArray(config.plugins)
    ? config.plugins.filter((entry) => !isV2AppToolsPlugin(entry))
    : undefined;
  if (Array.isArray(config.plugin))
    config.plugin = config.plugin.filter((entry) => !isAppToolsPlugin(entry));
  return JSON.stringify({
    ...config,
    permissions: [
      ...(Array.isArray(config.permissions) ? config.permissions : []),
      ...SERVER_RULES,
    ],
    ...(plugin !== undefined ? { plugins: [...(plugins ?? []), plugin] } : plugins && { plugins }),
  });
}

function readConfig(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === '') return {};
  // OpenCode accepts JSONC here, including trailing commas.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const trailing = /"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g;
  const json = text
    .replace(tokens, (token) => (token.startsWith('"') ? token : ' '))
    .replace(trailing, (token) => (token.startsWith('"') ? token : ''));
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A broken document would also cause OpenCode to drop the managed rules.
  }
  throw new Error('OpenCode 2 requires OPENCODE_CONFIG_CONTENT to be a JSON or JSONC object.');
}

function isV2AppToolsPlugin(entry: unknown): boolean {
  const spec =
    entry !== null && typeof entry === 'object' && 'package' in entry ? entry.package : entry;
  return (
    typeof spec === 'string' && spec.startsWith('file:') && spec.includes(`/${V2_PLUGIN_PREFIX}`)
  );
}

/** OpenCode 2 accepts a local Promise plugin without importing the plugin SDK at runtime. */
function v2AppToolsSource(): string {
  return `// SPDX-License-Identifier: MIT
const SESSION_HEADER = ${JSON.stringify(APP_TOOLS_ENGINE_SESSION_HEADER)};
const DISPATCH = new Set(${JSON.stringify([APP_TOOLS_CALL_READONLY, APP_TOOLS_CALL])});

export default {
  id: 'wevir.app-tools',
  async setup(ctx) {
    const { url, token, noApproval } = ctx.options;
    if (typeof url !== 'string' || typeof token !== 'string') return;
    const approved = new Set(noApproval);
    let nextId = 1;
    const rpc = async (method, params, signal, sessionID) => {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + token,
      };
      if (sessionID !== undefined) headers[SESSION_HEADER] = sessionID;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal,
      });
      if (response.status === 404) throw new Error('This OpenCode session does not belong to Wevir.');
      if (!response.ok) throw new Error('Wevir app tools: HTTP ' + response.status);
      const reply = await response.json();
      if (reply.error) throw new Error(reply.error.message || 'Wevir app tools failed');
      return reply.result ?? {};
    };

    let listed;
    try {
      listed = await rpc('tools/list', {}, AbortSignal.timeout(${APP_TOOLS_LIST_TIMEOUT_MS}));
    } catch {
      console.error('[wevir-app-tools] could not list the Wevir tools');
      return;
    }
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    await ctx.tool.transform((editor) => {
      for (const definition of tools) {
        const name = definition?.name;
        if (typeof name !== 'string') continue;
        // Earlier OpenCode 2 releases cannot request approvals from a Promise plugin.
        if (typeof ctx.permission.assert !== 'function' && !approved.has(name)) continue;
        editor.add({
          name,
          input: definition.inputSchema,
          description: definition.description ?? name,
          options: { codemode: false },
          async execute(args, context) {
            const { sessionID, agent, messageID, id, signal } = context;
            if (!sessionID) throw new Error('Wevir app tools require an OpenCode session.');
            const target = DISPATCH.has(name) && typeof args?.name === 'string' ? args.name : name;
            if (!approved.has(target)) {
              const resources = [DISPATCH.has(name) ? target : '*'];
              await ctx.permission.assert({
                sessionID, agent, action: name, resources, save: resources, metadata: args ?? {},
                source: { type: 'tool', messageID, id },
              });
            }
            const result = await rpc('tools/call', { name, arguments: args ?? {} }, signal, sessionID);
            const text = (Array.isArray(result.content) ? result.content : [])
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\\n') || JSON.stringify(result.structuredContent ?? result.content ?? {});
            if (result.isError === true) throw new Error(text || name + ' failed');
            return { content: text };
          },
        });
      }
    });
  },
};
`;
}
