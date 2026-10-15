// 消息里的图片（0.28.0，codex-event-mapping.md §4.2）：真实 codex-app-server + 网关 + mock 模型。图片以 `localImage`
// 交给 Codex，Codex 读文件、按 `input_image`（data URL）发给模型。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 图片');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

/** 1×1 的 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface ContentItem {
  type?: string;
  text?: string;
  image_url?: string;
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 图片（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(() => ({ text: ['看到了。'] }));
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('模型标了 supportsImages 才收；图片以 input_image 到达模型', async () => {
      const { home, workspace } = dirs.make('images');
      const adapter = newAdapter({
        home,
        providers: [
          mockProvider(mock, {
            models: [
              { id: MOCK_MODEL, displayName: 'Wevir Mock', supportsImages: true },
              { id: 'text-only' },
            ],
          }),
        ],
      });
      adapters.push(adapter);
      expect(adapter.acceptsImages({ providerId: 'mock', modelId: MOCK_MODEL })).toBe(true);
      expect(adapter.acceptsImages({ providerId: 'mock', modelId: 'text-only' })).toBe(false);
      expect(adapter.acceptsImages({ providerId: 'other', modelId: MOCK_MODEL })).toBe(false);

      const imagePath = join(home, 'shot.png');
      writeFileSync(imagePath, PNG);
      const { engineSessionId } = await adapter.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const events = collectEvents(adapter, engineSessionId);
      const before = mock.requests.length;
      await adapter.send(engineSessionId, {
        content: [
          { type: 'text', text: '这张图里是什么' },
          { type: 'image', path: imagePath, mimeType: 'image/png', name: 'shot.png' },
        ],
      });
      const turn = await finishTurn(events, 0);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

      const request = mock.requests.slice(before).at(-1);
      const user = request?.body.input.filter(
        (item) => item.type === 'message' && item.role === 'user',
      );
      const content = (user?.at(-1)?.content ?? []) as ContentItem[];
      expect(
        content.some((item) => item.type === 'input_text' && item.text === '这张图里是什么'),
      ).toBe(true);
      const image = content.find((item) => item.type === 'input_image');
      expect(image?.image_url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    });
  },
);
