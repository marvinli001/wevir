// 纯函数的单元测试：找可执行文件、模型目录、环境、回合结果的归类、工具展示。

import { describe, expect, it } from 'vitest';
import { claudeEnv, NESTED_SESSION_ENV } from './env.js';
import {
  claudePath,
  findClaude,
  findGitBash,
  GIT_BASH_ENV,
  isGitBashError,
  isWindowsLauncherShim,
  parseClaudeVersion,
  resolveWindowsShim,
} from './executable.js';
import {
  canonicalClaudeModel,
  claudeApiModelId,
  claudeContextWindow,
  claudeEffort,
  claudeModels,
  lowestClaudeEffort,
} from './model-catalog.js';
import type { SDKResultMessage } from './sdk.js';
import { recordedMessages } from './test-fixtures/fake-sdk.js';
import { applyTaskTool, askUserQuestions, todoWriteItems } from './todos.js';
import { claudeToolDisplay, isSubagentTool } from './tool-display.js';
import { isAbortedResult, resultFailure } from './turn-result.js';

describe('找 claude', () => {
  const files = (list: string[]) => (path: string) => list.includes(path);

  it('指定的路径优先（~ 展开），不存在时不再自动找', () => {
    const exists = files(['/home/me/bin/claude', '/usr/local/bin/claude']);
    expect(
      findClaude({
        customPath: '~/bin/claude',
        home: '/home/me',
        exists,
        platform: 'darwin',
        env: {},
      }),
    ).toBe('/home/me/bin/claude');
    expect(
      findClaude({
        customPath: '/missing/claude',
        home: '/home/me',
        exists,
        platform: 'darwin',
        env: {},
      }),
    ).toBe(undefined);
  });

  it('GUI 拉起的 Host 的 PATH 里没有 ~/.local/bin：照样找到官方安装脚本放的位置', () => {
    const exists = files(['/Users/me/.local/bin/claude']);
    expect(
      findClaude({
        home: '/Users/me',
        exists,
        platform: 'darwin',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      }),
    ).toBe('/Users/me/.local/bin/claude');
    expect(
      findClaude({
        home: '/Users/me',
        exists: files([]),
        platform: 'darwin',
        env: { PATH: '/usr/bin' },
      }),
    ).toBe(undefined);
  });

  it('WEVIR_CLAUDE_BIN；PATH 里的先于常见位置', () => {
    const exists = files(['/x/claude', '/opt/homebrew/bin/claude', '/Users/me/.local/bin/claude']);
    expect(
      findClaude({
        home: '/Users/me',
        exists,
        platform: 'darwin',
        env: { WEVIR_CLAUDE_BIN: '/x/claude' },
      }),
    ).toBe('/x/claude');
    expect(
      findClaude({
        home: '/Users/me',
        exists,
        platform: 'darwin',
        env: { PATH: '/opt/homebrew/bin' },
      }),
    ).toBe('/opt/homebrew/bin/claude');
  });

  it('Windows：npm 的启动脚本换成包入口（新版 bin/claude.exe，旧版 cli.js）', () => {
    expect(isWindowsLauncherShim('C:\\npm\\claude.cmd')).toBe(true);
    expect(isWindowsLauncherShim('C:\\x\\claude.exe')).toBe(false);
    const native = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    expect(resolveWindowsShim('C:\\npm\\claude.cmd', files([native]))).toBe(native);
    const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    expect(resolveWindowsShim('C:\\npm\\claude.cmd', files([script]))).toBe(script);
    expect(
      findClaude({
        home: 'C:\\Users\\me',
        exists: files([
          'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
          native.replace('C:\\npm', 'C:\\Users\\me\\AppData\\Roaming\\npm'),
        ]),
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', Path: 'C:\\Windows' },
      }),
    ).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    );
  });

  it('版本号与交给 claude 的 PATH', () => {
    expect(parseClaudeVersion('2.1.287 (Claude Code)\n')).toBe('2.1.287');
    expect(parseClaudeVersion('nope')).toBeUndefined();
    const path = claudePath(
      '/Users/me/.local/bin/claude',
      { PATH: '/usr/bin:/bin' },
      'darwin',
      '/Users/me',
      (dir) => dir === '/opt/homebrew/bin',
    );
    expect(path).toBe('/Users/me/.local/bin:/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('环境：去掉另一个 Claude Code 会话的标记，关掉后台任务', () => {
    const env = claudeEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: '/h', ANTHROPIC_API_KEY: 'k' },
      '/opt/claude',
    );
    for (const name of NESTED_SESSION_ENV) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({
      HOME: '/h',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });
});

describe('Windows 上找 Git Bash', () => {
  const files = (list: string[]) => (path: string) => list.includes(path);
  const find = (
    list: string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = 'win32',
    home = 'C:\\Users\\me',
  ) => findGitBash({ env, platform, home, exists: files(list) });
  const gitRoot = 'C:\\Program Files\\Git';

  it('CLAUDE_CODE_GIT_BASH_PATH 已设置且文件存在：优先于一切', () => {
    const custom = 'D:\\Tools\\Git\\bin\\bash.exe';
    expect(
      find([custom, `${gitRoot}\\bin\\bash.exe`], {
        [GIT_BASH_ENV]: custom,
        ProgramFiles: 'C:\\Program Files',
      }),
    ).toBe(custom);
    // 名字不分大小写，值两端的空白去掉。
    expect(find([custom], { claude_code_git_bash_path: `  ${custom} ` })).toBe(custom);
  });

  it('变量指向不存在的文件：忽略，继续找', () => {
    expect(
      find([`${gitRoot}\\bin\\bash.exe`], {
        [GIT_BASH_ENV]: 'D:\\gone\\bash.exe',
        ProgramFiles: 'C:\\Program Files',
      }),
    ).toBe(`${gitRoot}\\bin\\bash.exe`);
    expect(find([], { [GIT_BASH_ENV]: 'D:\\gone\\bash.exe' })).toBeUndefined();
  });

  it('PATH 里的 git.exe 推出 Git 根：cmd\\、bin\\、mingw64\\bin\\ 三种位置', () => {
    const bash = 'D:\\Dev\\Git\\bin\\bash.exe';
    for (const dir of ['D:\\Dev\\Git\\cmd', 'D:\\Dev\\Git\\bin', 'D:\\Dev\\Git\\mingw64\\bin']) {
      expect(find([`${dir}\\git.exe`, bash], { Path: `C:\\Windows;${dir};C:\\x` })).toBe(bash);
    }
    // PATH 项带引号、尾部有空格也认；PATH 的名字大小写不限。
    expect(
      find(['D:\\Dev\\Git\\cmd\\git.exe', bash], { PATH: '"D:\\Dev\\Git\\cmd" ;C:\\Windows' }),
    ).toBe(bash);
  });

  it('不在 PATH 里直接找 bash.exe：System32 的那个是 WSL', () => {
    expect(
      find(['C:\\Windows\\System32\\bash.exe'], { Path: 'C:\\Windows\\System32' }),
    ).toBeUndefined();
  });

  it('PATH 里的 git 推出的路径先于常见位置', () => {
    const fromPath = 'D:\\Dev\\Git\\bin\\bash.exe';
    const common = `${gitRoot}\\bin\\bash.exe`;
    expect(
      find(['D:\\Dev\\Git\\cmd\\git.exe', fromPath, common], {
        Path: 'D:\\Dev\\Git\\cmd',
        ProgramFiles: 'C:\\Program Files',
      }),
    ).toBe(fromPath);
  });

  it('常见位置：ProgramFiles、ProgramFiles(x86)、LOCALAPPDATA\\Programs、scoop', () => {
    const env = {
      Path: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    };
    const x64 = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const x86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
    const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    const scoop = 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe';
    expect(find([x64, x86, perUser, scoop], env)).toBe(x64);
    expect(find([x86, perUser, scoop], env)).toBe(x86);
    expect(find([perUser, scoop], env)).toBe(perUser);
    expect(find([scoop], env)).toBe(scoop);
    expect(find([], env)).toBeUndefined();
  });

  it('只在 Windows 上找', () => {
    const list = [`${gitRoot}\\bin\\bash.exe`];
    expect(find(list, { ProgramFiles: 'C:\\Program Files' }, 'darwin')).toBeUndefined();
    expect(find(list, { ProgramFiles: 'C:\\Program Files' }, 'linux')).toBeUndefined();
  });

  it('claude 缺 Git Bash 的报错', () => {
    expect(
      isGitBashError(
        '`claude --version` failed: Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
      ),
    ).toBe(true);
    expect(isGitBashError('`claude --version` failed: boom')).toBe(false);
  });

  it('交给 claude 的环境（Windows）：找到就带上 CLAUDE_CODE_GIT_BASH_PATH，旧写法不并存', () => {
    const bash = `${gitRoot}\\bin\\bash.exe`;
    const env = claudeEnv(
      {
        Path: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        Claude_Code_Git_Bash_Path: 'D:\\gone\\bash.exe',
      },
      'C:\\Users\\me\\.local\\bin\\claude.exe',
      {
        platform: 'win32',
        home: 'C:\\Users\\me',
        exists: files([bash]),
        isDir: () => false,
      },
    );
    expect(env[GIT_BASH_ENV]).toBe(bash);
    expect(
      Object.keys(env).filter((name) => name.toLowerCase() === GIT_BASH_ENV.toLowerCase()),
    ).toEqual([GIT_BASH_ENV]);
    expect(env.PATH).toBe('C:\\Users\\me\\.local\\bin;C:\\Windows');
    expect(env.Path).toBeUndefined();
  });

  it('交给 claude 的环境（Windows）：找不到时不编一个，原来的值照旧；非 Windows 不碰', () => {
    const lost = claudeEnv({ Path: 'C:\\Windows' }, undefined, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exists: files([]),
      isDir: () => false,
    });
    expect(GIT_BASH_ENV in lost).toBe(false);
    const stale = claudeEnv({ [GIT_BASH_ENV]: 'D:\\gone\\bash.exe' }, undefined, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exists: files([]),
      isDir: () => false,
    });
    expect(stale[GIT_BASH_ENV]).toBe('D:\\gone\\bash.exe');
    const mac = claudeEnv({ PATH: '/usr/bin' }, '/opt/claude', {
      platform: 'darwin',
      exists: files([`${gitRoot}\\bin\\bash.exe`]),
      isDir: () => false,
    });
    expect(GIT_BASH_ENV in mac).toBe(false);
  });
});

describe('模型目录（T3 的随包清单）', () => {
  it('按版本过滤：current 在前，没有版本时只留没有版本要求的', () => {
    const models = claudeModels('2.1.287');
    const ids = models.models.map((model) => model.id);
    expect(ids.slice(0, 3)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
    expect(ids).not.toContain('claude-haiku-5-5');
    expect(ids).toContain('claude-haiku-4-5');
    expect(models.defaultModelId).toBe('claude-fable-5-1');
    expect(claudeModels('2.1.300').models.map((model) => model.id)).toContain('claude-haiku-5-5');
    expect(claudeModels(undefined).models.every((model) => model.id !== 'claude-opus-5-5')).toBe(
      true,
    );
  });

  it('档位：只留 Wevir 认识的值；effortMap 换算；上下文窗口与 [1m] 后缀', () => {
    const opus = claudeModels('2.1.287').models.find((model) => model.id === 'claude-opus-5-5');
    expect(opus).toMatchObject({
      displayName: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(claudeEffort('claude-opus-4-7', 'xhigh')).toBe('max');
    expect(claudeEffort('claude-sonnet-4-6', 'max')).toBe('high');
    expect(claudeEffort('claude-opus-5-5', 'off')).toBeUndefined();
    expect(claudeEffort('claude-opus-5-5', undefined)).toBeUndefined();
    expect(lowestClaudeEffort('claude-opus-5-5')).toBe('low');
    expect(claudeApiModelId('claude-opus-4-6')).toBe('claude-opus-4-6[1m]');
    expect(claudeApiModelId('sonnet')).toBe('claude-sonnet-5-5');
    expect(claudeApiModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(claudeContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(canonicalClaudeModel('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(canonicalClaudeModel('haiku-4.5')).toBe('claude-haiku-4-5');
  });
});

describe('回合结果（录音里的真实结果）', () => {
  const resultOf = (name: string) =>
    recordedMessages(name).find(
      (message): message is SDKResultMessage => message.type === 'result',
    ) as SDKResultMessage;

  it('完成、中断', () => {
    expect(resultFailure(resultOf('plain'), false)).toBeUndefined();
    expect(isAbortedResult(resultOf('plain'))).toBe(false);
    const interrupted = resultOf('approval.interrupt');
    expect(isAbortedResult(interrupted)).toBe(true);
  });

  it('API 失败归类：401 / 认证失败 → missing_credentials，429 / 529 → provider；[ede_diagnostic] 不当错误显示', () => {
    const base = resultOf('plain');
    expect(
      resultFailure(
        { ...base, is_error: true, api_error_status: 429, result: 'x' } as SDKResultMessage,
        false,
      ),
    ).toMatchObject({
      category: 'provider',
      code: 429,
      message: 'Claude API rate limit reached. Try again later.',
    });
    expect(
      resultFailure(
        {
          ...base,
          is_error: true,
          api_error_status: 401,
          result: 'Please run /login',
        } as SDKResultMessage,
        false,
      ),
    ).toMatchObject({
      category: 'missing_credentials',
      message: 'Please run /login',
    });
    expect(
      resultFailure(
        {
          ...base,
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['[ede_diagnostic] x', 'Reached max turns'],
        } as unknown as SDKResultMessage,
        false,
      ),
    ).toMatchObject({ category: 'unknown', message: 'Reached max turns' });
  });
});

describe('工具展示、清单与提问', () => {
  it('Claude Code 的工具名 → 展示类型', () => {
    expect(claudeToolDisplay('Bash', { command: 'git status\n--short' })).toEqual({
      kind: 'shell',
      command: 'git status\n--short',
      summary: 'git status',
    });
    expect(
      claudeToolDisplay('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
    ).toEqual({
      kind: 'edit',
      paths: ['a.ts'],
      summary: 'a.ts',
    });
    expect(claudeToolDisplay('Grep', { pattern: 'TODO', path: 'src' })).toEqual({
      kind: 'search',
      query: 'TODO',
      summary: 'TODO',
      paths: ['src'],
    });
    expect(claudeToolDisplay('WebFetch', { url: 'https://example.com' })).toMatchObject({
      kind: 'fetch',
      url: 'https://example.com',
    });
    expect(claudeToolDisplay('Agent', { description: 'Find files' })).toEqual({
      kind: 'sub_agent',
      summary: 'Find files',
    });
    expect(claudeToolDisplay('TodoWrite', {})).toEqual({ kind: 'plan' });
    expect(claudeToolDisplay('mcp__github__create_issue', { title: 'x' })).toMatchObject({
      kind: 'unknown',
      mcpServer: 'github',
    });
    expect(isSubagentTool('Task')).toBe(true);
  });

  it('TodoWrite、Task* 与 AskUserQuestion', () => {
    expect(
      todoWriteItems({ todos: [{ content: 'a', status: 'completed' }, { content: '' }] }),
    ).toEqual([{ content: 'a', status: 'completed' }]);
    const created = applyTaskTool(
      new Map(),
      'TaskCreate',
      { subject: 'x' },
      { task: { id: '1', subject: 'x' } },
    );
    expect([...(created ?? new Map()).values()]).toEqual([{ content: 'x', status: 'pending' }]);
    const updated = applyTaskTool(
      created ?? new Map(),
      'TaskUpdate',
      { taskId: '1', status: 'in_progress' },
      { success: true },
    );
    expect([...(updated ?? new Map()).values()]).toEqual([{ content: 'x', status: 'in_progress' }]);
    const deleted = applyTaskTool(
      updated ?? new Map(),
      'TaskUpdate',
      { taskId: '1', status: 'deleted' },
      {},
    );
    expect(deleted?.size).toBe(0);
    expect(
      askUserQuestions({
        questions: [{ question: 'Q?', options: [{ label: 'A', description: 'd' }] }],
      }),
    ).toEqual([
      {
        id: 'Q?',
        header: 'Question 1',
        question: 'Q?',
        options: [{ label: 'A', description: 'd' }],
        multiSelect: false,
        allowOther: true,
      },
    ]);
  });
});
