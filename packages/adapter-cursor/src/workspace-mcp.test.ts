import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stripJsonc, workspaceMcpServers } from './workspace-mcp.js';

/** mcp.json 里的字面占位符 `${name}`。 */
const v = (name: string) => `\${${name}}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-cursor-mcp-')));
  dirs.push(dir);
  return dir;
}

describe('工作区 mcp.json 的变量展开（T3 cc97303381）', () => {
  // Windows 上建符号链接要权限。
  it.skipIf(process.platform === 'win32')(
    '只覆盖字面那份起不来的 stdio 服务；项目的先于用户的；关掉的不带；读不了关掉的列表时报错',
    async () => {
      const root = scratch();
      const workspace = join(root, 'workspace');
      const home = join(root, 'home');
      mkdirSync(join(workspace, 'packages', 'app'), { recursive: true });
      mkdirSync(join(workspace, '.cursor'), { recursive: true });
      mkdirSync(join(home, '.cursor'), { recursive: true });
      // Cursor 与 git 一样经符号链接解析项目根。
      symlinkSync(workspace, join(root, 'link'));
      const cwd = join(root, 'link', 'packages', 'app');
      execFileSync('git', ['init', '--quiet', workspace]);
      const projectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd })
        .toString()
        .trim();
      writeFileSync(
        join(workspace, '.cursor', 'mcp.json'),
        `{
        // Cursor 的编辑器允许注释。
        "mcpServers": {
          "repro": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "startupTimeoutSec": 120 },
          "plain": { "command": "node", "args": ["server.mjs"] },
          "argument-only": { "command": "node", "args": ["server.mjs", "--workspace", "\${workspaceFolder}"] },
          "env-only": { "command": "node", "args": ["server.mjs"], "env": { "PROJECT_ROOT": "\${workspaceFolder}" } },
          "cwd-only": { "command": "node", "args": ["server.mjs"], "cwd": "\${workspaceFolder}" },
          "wrapped": { "command": "proto", "args": ["run", "node", "--", "\${workspaceFolder}/server.mjs"] },
          "env-file": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "envFile": ".env.mcp" },
          "tool-filter": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "enabledTools": ["read_file"] },
          "off": { "command": "node", "args": ["\${workspaceFolder}/off.mjs"] },
          "typed": { "type": "\${env:MCP_TYPE}", "command": "\${userHome}/bin/server", "env": { "TOKEN": "\${env:UNSET}" } },
          "plugin-docs-search": { "command": "node", "args": ["\${workspaceFolder}/search.mjs"] },
        },
      }`,
      );
      writeFileSync(
        join(home, '.cursor', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            repro: { command: 'node', args: [`${v('userHome')}/shadowed.mjs`] },
            docs: { url: `https://docs.example/${v('workspaceFolderBasename')}` },
            'user-script': { command: 'python3', args: [`${v('userHome')}/tools/mcp.py`] },
          },
        }),
      );
      const projectDir = join(
        home,
        '.cursor',
        'projects',
        projectRoot
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, ''),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'mcp-disabled.json'), JSON.stringify(['off']));

      const load = () => workspaceMcpServers(cwd, { env: { MCP_TYPE: 'stdio' }, userHome: home });
      const expected = {
        repro: { command: 'node', args: [`${projectRoot}/server.mjs`], cwd: projectRoot },
        'cwd-only': { command: 'node', args: ['server.mjs'], cwd: projectRoot },
        typed: {
          type: 'stdio',
          command: `${home}/bin/server`,
          env: { TOKEN: '' },
          cwd: projectRoot,
        },
        'user-script': { command: 'python3', args: [`${home}/tools/mcp.py`], cwd: projectRoot },
      };
      expect(await load()).toEqual(expected);

      // 两次之间关掉的服务，下一次就不带。
      writeFileSync(join(projectDir, 'mcp-disabled.json'), JSON.stringify(['off', 'repro']));
      const { repro: _disabled, ...stillEnabled } = expected;
      expect(await load()).toEqual(stillEnabled);

      // CURSOR_DATA_DIR 换掉 ~/.cursor 存项目状态的位置。
      const dataDir = join(root, 'data');
      expect(
        await workspaceMcpServers(cwd, {
          env: { MCP_TYPE: 'stdio', CURSOR_DATA_DIR: dataDir },
          userHome: home,
        }),
      ).toEqual({ ...stillEnabled, repro: expected.repro, off: expect.anything() });

      writeFileSync(join(projectDir, 'mcp-disabled.json'), '[');
      await expect(load()).rejects.toThrow();

      // 没有要展开的服务时是空的。
      writeFileSync(
        join(workspace, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { plain: { command: 'node', args: ['server.mjs'] } } }),
      );
      rmSync(join(home, '.cursor', 'mcp.json'));
      expect(await load()).toEqual({});
    },
  );

  it('不在 git 仓库里时项目根是工作目录；形状不对的文件整个不用', async () => {
    const root = scratch();
    mkdirSync(join(root, '.cursor'));
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'node', args: [`${v('workspaceFolder')}/a.mjs`] },
          bad: { command: 'node', args: [1] },
        },
      }),
    );
    expect(await workspaceMcpServers(root, { env: {}, userHome: join(root, 'home') })).toEqual({});
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { good: { command: 'node', args: [`${v('workspaceFolder')}/a.mjs`] } },
      }),
    );
    expect(await workspaceMcpServers(root, { env: {}, userHome: join(root, 'home') })).toEqual({
      good: { command: 'node', args: [`${root}/a.mjs`], cwd: root },
    });
  });

  it('JSONC：去掉注释与尾逗号，字符串里的不动', () => {
    const text = `{
      // line
      "a": "http://x//y", /* block */ "b": "/* kept */",
      "c": [1, 2, /* x */ ],
      "d": "quote \\" , }",
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      a: 'http://x//y',
      b: '/* kept */',
      c: [1, 2],
      d: 'quote " , }',
    });
  });
});
