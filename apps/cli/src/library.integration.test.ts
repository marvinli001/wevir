// 记忆、插件 / Skills / 连接器、设置与给 Agent 的说明，以及 Provider、工作区的管理命令，对着进程内的 echo Host。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { afterEach, describe, expect, it } from 'vitest';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup() {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'project');
  mkdirSync(workspace);
  host = await startEchoHost(home);
  return { home, workspace };
}

const note = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\nBody of ${name}.\n`;

describe('wevir memory', () => {
  it('list、show、edit、disable / enable、delete；-w 指向项目的笔记', async () => {
    const { home, workspace } = await setup();
    mkdirSync(join(home, 'memory', 'global'), { recursive: true });
    writeFileSync(join(home, 'memory', 'global', 'build-cmd.md'), note('build-cmd', 'Use pnpm'));
    expect((await run(['memory', 'list'], { home })).out).toMatch(
      /build-cmd\s+全局\s+项目\s+启用\s+Use pnpm/,
    );
    const shown = await run(['memory', 'show', 'build-cmd'], { home });
    expect(shown.out).toContain('Body of build-cmd.');

    const edited = await run(
      ['memory', 'edit', 'build-cmd', '--description', 'Use pnpm 10', '--stdin'],
      { home, input: 'Run pnpm install first.\nThen pnpm build.\n' },
    );
    expect(edited.code, edited.err).toBe(0);
    expect(edited.out).toContain('已保存：build-cmd');
    const json = JSON.parse((await run(['memory', 'show', 'build-cmd', '--json'], { home })).out);
    expect(json).toMatchObject({
      description: 'Use pnpm 10',
      content: 'Run pnpm install first.\nThen pnpm build.',
    });
    const badType = await run(['memory', 'edit', 'build-cmd', '--type', 'secret'], { home });
    expect(badType.code).toBe(2);
    expect((await run(['memory', 'edit', 'build-cmd'], { home })).err).toContain(
      '没有要修改的内容',
    );

    expect((await run(['memory', 'disable', 'build-cmd'], { home })).out).toContain(
      '已停用：build-cmd',
    );
    expect((await run(['memory', 'list'], { home })).out).toMatch(/build-cmd\s+全局\s+项目\s+停用/);
    await run(['memory', 'enable', 'build-cmd'], { home });
    expect((await run(['memory', 'delete', 'build-cmd'], { home })).out).toContain(
      '已删除：build-cmd',
    );
    expect((await run(['memory', 'list'], { home })).out).toContain('暂无记忆笔记');

    // 项目的笔记：工作区登记之后按路径找。
    await run(['workspace', 'add', workspace], { home });
    const { workspaces } = {
      workspaces: JSON.parse((await run(['workspace', 'list', '--json'], { home })).out) as Array<{
        id: string;
      }>,
    };
    const dir = join(home, 'memory', 'projects', workspaces[0]?.id as string);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'layout.md'), note('layout', 'Monorepo'));
    expect((await run(['memory', 'list'], { home })).out).not.toContain('layout');
    expect((await run(['memory', 'list', '-w', workspace], { home })).out).toMatch(
      /layout\s+项目\s+项目\s+启用\s+Monorepo/,
    );
    expect((await run(['memory', 'show', 'layout', '-w', workspace], { home })).out).toContain(
      'Body of layout.',
    );
  });
});

describe('wevir plugin 与 mcp', () => {
  it('安装 Skill、加连接器、列出、停用 / 启用、删除', async () => {
    const { home } = await setup();
    const skillDir = join(tempDir(), 'greet');
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: greet\ndescription: Say hello in the house style\n---\n\nSay hello.\n',
    );
    const installed = await run(['plugin', 'install', skillDir], { home });
    expect(installed.code, installed.err).toBe(0);
    expect(installed.out).toContain('已安装 Skill：greet');

    const added = await run(['mcp', 'add', 'files', '--disabled', '--', 'node', 'server.js'], {
      home,
    });
    expect(added.code, added.err).toBe(0);
    expect(added.out).toMatch(/已添加连接器：files（\S+）/);
    const missing = await run(['mcp', 'add', 'nothing'], { home });
    expect(missing.code).toBe(2);

    const list = await run(['plugin', 'list'], { home });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toContain('Skills');
    expect(list.out).toMatch(/greet\s+Wevir\s+启用\s+Say hello in the house style/);
    expect(list.out).toMatch(/skill-creator\s+内置/);
    expect(list.out).toContain('连接器');
    expect(list.out).toMatch(/files\s+stdio\s+停用/);

    const json = JSON.parse((await run(['plugin', 'list', '--json'], { home })).out) as {
      skills: Array<{ id: string; name: string }>;
      connectors: Array<{ id: string; name: string }>;
    };
    const skill = json.skills.find((s) => s.name === 'greet');
    const connector = json.connectors.find((c) => c.name === 'files');
    expect((await run(['plugin', 'disable', skill?.id as string], { home })).out).toContain(
      '已停用：greet',
    );
    expect((await run(['plugin', 'enable', connector?.id as string], { home })).out).toContain(
      '已启用：files',
    );
    expect((await run(['plugin', 'remove', connector?.id as string], { home })).out).toContain(
      '已删除：files',
    );
    const unknown = await run(['plugin', 'remove', 'nope'], { home });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('没有这个插件、Skill 或连接器：nope');
  });
});

describe('wevir settings 与 instructions', () => {
  it('列出、按类型改设置；未知的键与不接受的值', async () => {
    const { home } = await setup();
    const list = await run(['settings'], { home });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/sendWhileBusy\s+steer/);
    expect((await run(['settings', 'set', 'sendWhileBusy', 'queue'], { home })).out).toContain(
      '已保存：sendWhileBusy = queue',
    );
    expect((await run(['settings', 'set', 'autoMemory', 'off'], { home })).out).toContain(
      '已保存：autoMemory = off',
    );
    const json = JSON.parse((await run(['settings', '--json'], { home })).out);
    expect(json).toMatchObject({ sendWhileBusy: 'queue', autoMemory: false });
    const unknown = await run(['settings', 'set', 'colour', 'blue'], { home });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('未知设置：colour');
    const bad = await run(['settings', 'set', 'sendWhileBusy', 'later'], { home });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('sendWhileBusy 不接受该值：later');
  });

  it('instructions set / show / clear，- 从 stdin 读', async () => {
    const { home } = await setup();
    expect((await run(['instructions'], { home })).out).toContain('暂无说明');
    const set = await run(['instructions', 'set', 'Answer', 'in', 'English.'], { home });
    expect(set.code, set.err).toBe(0);
    expect(set.out).toContain('已保存说明（18 字）');
    expect((await run(['instructions', 'show'], { home })).out).toContain('Answer in English.');
    await run(['instructions', 'set', '-'], { home, input: 'Line one\nLine two\n' });
    expect((await run(['instructions'], { home })).out).toContain('Line one\nLine two');
    expect((await run(['instructions', 'clear'], { home })).out).toContain('已清除说明');
    expect((await run(['instructions'], { home })).out).toContain('暂无说明');
  });
});

describe('Provider 与工作区的管理', () => {
  it('provider list --json、disable / enable、remove；workspace rename / remove', async () => {
    const { home, workspace } = await setup();
    await run(
      [
        'provider',
        'add',
        '--kind',
        'openai-compatible',
        '--id',
        'echo-test',
        '--base-url',
        'http://127.0.0.1:9/v1',
        '--model',
        'echo-model',
      ],
      { home, input: 'sk-from-stdin\n' },
    );
    const providers = JSON.parse(
      (await run(['provider', 'list', '--json'], { home })).out,
    ) as Array<{
      id: string;
      hasSecret: boolean;
    }>;
    expect(providers).toMatchObject([{ id: 'echo-test', hasSecret: true }]);
    expect(JSON.stringify(providers)).not.toContain('sk-from-stdin');
    expect((await run(['provider', 'disable', 'echo-test'], { home })).out).toContain(
      '已停用：echo-test',
    );
    expect((await run(['provider', 'enable', 'echo-test'], { home })).out).toContain(
      '已启用：echo-test',
    );
    const models = await run(['provider', 'models', 'echo-test'], { home });
    expect(models.code).toBe(1);
    expect(models.err).toContain('列出模型失败');
    expect((await run(['provider', 'remove', 'echo-test'], { home })).out).toContain(
      '已删除 Provider：echo-test（echo-test）',
    );
    expect((await run(['provider', 'remove', 'echo-test'], { home })).code).toBe(1);

    await run(['workspace', 'add', workspace], { home });
    expect(
      (await run(['workspace', 'rename', workspace, 'My', 'project'], { home })).out,
    ).toContain('已改名：My project');
    expect((await run(['workspace', 'list'], { home })).out).toContain('My project');
    expect((await run(['workspace', 'remove', workspace], { home })).out).toContain(
      '已移除工作区：My project',
    );
    expect((await run(['workspace', 'list'], { home })).out).toContain('暂无工作区');
  });
});
