import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { ThemeFile } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';
import { THEME_GUIDE } from './theme-tools.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch (error) {
  console.warn(`[主题工具 + codex] 跳过：${(error as Error).message}`);
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SCENE =
  '<!doctype html><html><body><canvas id="sky"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,20,20)</script></body></html>';
const THEME: ThemeFile = {
  schemaVersion: 1,
  name: 'Mock constellation',
  colorScheme: 'dark',
  accent: '#458dbc',
  dark: { background: '#183042', foreground: '#e9f2f8' },
  backdrop: { kind: 'scene', file: 'backdrop.html', poster: 'poster.png', glass: true },
};

function toolCall(body: MockRequestBody, name: string, args: unknown) {
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace') {
      const found = (tool.tools as Array<{ name?: string }>).some((item) => item.name === name);
      if (found)
        return { toolCalls: [{ kind: 'function' as const, name, namespace: tool.name, args }] };
    } else if (tool.name?.endsWith(name)) {
      return { toolCalls: [{ kind: 'function' as const, name: tool.name, args }] };
    }
  }
  throw new Error(`mock 请求里没有 ${name}`);
}

function outputText(output: string): string {
  const text = output.replace(/^Wall time: [\d.]+ seconds\nOutput:\n/, '');
  try {
    const content: unknown = JSON.parse(text);
    if (Array.isArray(content))
      return content.map((part: { text?: string }) => part.text ?? '').join('\n');
  } catch {}
  return text;
}

function resultOf(output: string, outputDir: string) {
  const text = outputText(output);
  const spilled = /saved it to:\n([^\n]+)/.exec(text)?.[1];
  if (spilled !== undefined) {
    expect(spilled.startsWith(`${outputDir}/`) || spilled.startsWith(`${outputDir}\\`)).toBe(true);
    return JSON.parse(readFileSync(spilled, 'utf8'));
  }
  return JSON.parse(text);
}

describe.skipIf(binary === undefined)(
  '主题工具（真实 codex-app-server + 本地 mock 模型）',
  { timeout: 120_000 },
  () => {
    it('read → 引擎准备场景和 poster → set → default，复制素材并返回真实客户端在场状态', async () => {
      const root = tempDir();
      const home = join(root, 'home');
      const userHome = join(root, 'user');
      mkdirSync(userHome, { recursive: true });
      let cwd = '';
      let readOutput = '';
      let setOutput = '';
      let defaultOutput = '';
      const script: MockScript = (view) => {
        if ((view.body.tools ?? []).length === 0) return { text: ['ok'] };
        if (view.lastUserText.startsWith('[theme-default]')) {
          if (view.toolOutputs.length === 0)
            return toolCall(view.body, 'wevir_theme_set', { themeId: 'default' });
          defaultOutput = view.toolOutputs[0] ?? '';
          return { text: ['restored'] };
        }
        if (!view.lastUserText.startsWith('[theme]')) return { text: ['ok'] };
        if (view.toolOutputs.length === 0) {
          expect(JSON.stringify(view.body)).not.toContain(THEME_GUIDE);
          return toolCall(view.body, 'wevir_theme_read', { themeId: 'tideline' });
        }
        if (view.toolOutputs.length === 1) {
          readOutput = view.toolOutputs[0] ?? '';
          return {
            toolCalls: [
              {
                kind: 'function',
                name: 'exec_command',
                args: {
                  cmd: `node -e "const fs=require('node:fs');fs.writeFileSync('backdrop.html',Buffer.from('${Buffer.from(SCENE).toString('base64')}','base64'));fs.writeFileSync('poster.png',Buffer.from('${PNG}','base64'))"`,
                },
              },
            ],
          };
        }
        if (view.toolOutputs.length === 2) {
          return toolCall(view.body, 'wevir_theme_set', {
            themeId: 'mock-constellation',
            theme: THEME,
            files: { backdrop: join(cwd, 'backdrop.html'), poster: join(cwd, 'poster.png') },
          });
        }
        setOutput = view.toolOutputs[2] ?? '';
        return { text: ['applied'] };
      };
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const host = await startHost({
        home,
        userHome,
        pluginUserHome: userHome,
        importEnv: {},
        adapter: new CodexRuntime({
          home,
          binary,
          parentEnv: { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome },
          clientInfo: { name: 'wevir', version: '0.0.0' },
        }),
        engine: 'codex',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(host.url);
      cleanups.push(() => client.ws.close());
      await client.hello(info.token as string);
      await client.request('provider.upsert', {
        id: 'theme-mock',
        kind: 'openai-compatible',
        displayName: 'Theme Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        compat: { toolSearch: 'off' },
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });
      const { session } = await client.request('session.create', {
        providerId: 'theme-mock',
        permissionMode: 'full_access',
      });
      cwd = session.cwd;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId: session.id,
        sinceSeq: 0,
      });
      const send = async (text: string) => {
        const sent = await client.request('session.send', {
          sessionId: session.id,
          content: [{ type: 'text', text }],
        });
        await client.until(
          () =>
            client
              .events(subscriptionId)
              .find(
                (event) => event.type === 'turn.finished' && event.payload.turnId === sent.turnId,
              ),
          'turn.finished',
          90_000,
        );
      };

      await send('[theme] Change Wevir itself to the constellation theme.');
      const outputDir = join(home, 'tool-output', session.id);
      const read = resultOf(readOutput, outputDir);
      expect(read).toMatchObject({
        activeId: null,
        directory: join(home, 'themes'),
        current: null,
        requested: { id: 'tideline', readOnly: true },
        guide: THEME_GUIDE,
      });
      expect(read.themes.map((theme: { id: string }) => theme.id)).toEqual(
        expect.arrayContaining(['tideline', 'paper-garden', 'night-orbit']),
      );
      const set = resultOf(setOutput, outputDir);
      const saved = await client.request('themes.get', { id: 'mock-constellation' });
      expect(set).toMatchObject({ activeId: 'mock-constellation', uiConnected: false });
      expect(set.problems).toEqual(saved.problems);
      expect((await client.request('themes.list')).activeId).toBe('mock-constellation');
      expect(
        JSON.parse(readFileSync(join(home, 'themes/mock-constellation/theme.json'), 'utf8')),
      ).toEqual(THEME);
      expect(readFileSync(join(home, 'themes/mock-constellation/backdrop.html'), 'utf8')).toBe(
        SCENE,
      );
      expect(readFileSync(join(home, 'themes/mock-constellation/poster.png'))).toEqual(
        Buffer.from(PNG, 'base64'),
      );
      expect(await (await fetch(saved.assets.file)).text()).toBe(SCENE);
      expect(Buffer.from(await (await fetch(saved.assets.poster)).arrayBuffer())).toEqual(
        Buffer.from(PNG, 'base64'),
      );

      const desktop = await TestRpcClient.connect(host.url);
      cleanups.push(() => desktop.ws.close());
      await desktop.hello(info.token as string, {
        deviceId: 'theme-test',
        clientId: 'theme-desktop',
        clientKind: 'desktop',
      });
      await send('[theme-default] Restore the default Wevir appearance.');
      expect(resultOf(defaultOutput, outputDir)).toEqual({
        activeId: null,
        problems: [],
        uiConnected: true,
      });
      expect((await client.request('themes.list')).activeId).toBeNull();
      const events = client.events(subscriptionId);
      expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
      const names = events.flatMap((event) =>
        event.type === 'tool.started' ? [event.payload.toolName] : [],
      );
      expect(names.filter((name) => name.includes('wevir_theme_read'))).toHaveLength(1);
      expect(names.filter((name) => name.includes('wevir_theme_set'))).toHaveLength(2);
      expect(events.filter((event) => event.type === 'turn.finished')).toHaveLength(2);
    });
  },
);
