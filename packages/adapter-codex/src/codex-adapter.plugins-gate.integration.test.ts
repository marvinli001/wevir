// P1 前置实验：锁定的真实 app-server，临时 HOME / 项目 / 额外根目录；检查禁用规则与显式提及。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, mockProvider, startMockModel } from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('plugins skills gate');
const dirs = new TempDirs();
afterAll(() => dirs.cleanup());

describe.skipIf(binary === undefined || process.platform === 'win32')('plugins skills gate', () => {
  it('禁用项不列给模型，也不能由 $name 注入；启用的额外根目录可用', async () => {
    const { root, home, workspace } = dirs.make('plugins-gate');
    const userHome = join(root, 'user-home');
    const extra = join(home, 'plugins', 'skills');
    const skill = (base: string, name: string) => {
      const folder = join(base, name);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, 'SKILL.md');
      writeFileSync(
        path,
        `---\nname: ${name}\ndescription: ${name} description\n---\nBODY-${name}-c42d\n`,
      );
      return path;
    };
    const user = skill(join(userHome, '.agents', 'skills'), 'gate-user');
    const project = skill(join(workspace, '.agents', 'skills'), 'gate-project');
    skill(extra, 'gate-wevir');
    const model = await startMockModel(() => ({ text: ['ok'] }));
    const a = newAdapter({
      home,
      binary,
      parentEnv: { ...process.env, HOME: userHome },
      providers: [mockProvider(model)],
    });
    try {
      await a.process.start();
      await a.process.request('config/batchWrite', {
        edits: [
          { keyPath: 'skills.include_instructions', value: true, mergeStrategy: 'replace' },
          {
            keyPath: 'skills.config',
            value: [
              { path: user, enabled: false },
              { path: project, enabled: false },
            ],
            mergeStrategy: 'replace',
          },
        ],
        reloadUserConfig: true,
      });
      await a.process.request('skills/extraRoots/set', { extraRoots: [extra] });
      const listing = await a.process.request<{
        data: Array<{ skills: Array<{ name: string; enabled: boolean }> }>;
      }>('skills/list', { cwds: [workspace], forceReload: true });
      const skills = listing.data.flatMap((entry) => entry.skills);
      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'gate-user', enabled: false }),
          expect.objectContaining({ name: 'gate-project', enabled: false }),
          expect.objectContaining({ name: 'gate-wevir', enabled: true }),
        ]),
      );
      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const events = collectEvents(a, session.engineSessionId);
      await runTurn(a, session.engineSessionId, 'hello', events);
      const input = () => JSON.stringify(model.requests.at(-1)?.body.input ?? []);
      expect(input()).toContain('gate-wevir');
      expect(input()).not.toContain('gate-user');
      expect(input()).not.toContain('gate-project');
      await runTurn(a, session.engineSessionId, 'please use $gate-user and $gate-project', events);
      expect(input()).not.toContain('BODY-gate-user-c42d');
      expect(input()).not.toContain('BODY-gate-project-c42d');
      await runTurn(a, session.engineSessionId, 'please use $gate-wevir', events);
      expect(input()).toContain('BODY-gate-wevir-c42d');
    } finally {
      await a.dispose();
      await model.close();
    }
  }, 90_000);
});
