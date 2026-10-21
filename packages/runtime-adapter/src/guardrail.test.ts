import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GUARDRAIL_MARKER,
  GUARDRAIL_TOOL_MATCHER,
  guardrailChecker,
  guardrailCheckerCommand,
  guardrailHooks,
  parseGuardrailMarkers,
  repoHookCommand,
  writeGuardrailChecker,
} from './guardrail.js';

const WORKSPACE = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR';
const root = mkdtempSync(join(tmpdir(), 'wevir-guardrail-'));
const checker = guardrailChecker(join(root, 'guardrails'));
const cwd = join(root, 'project');

// biome-ignore lint/suspicious/noExplicitAny: 脚本是 JS，测试只调它导出的函数。
let script: any;

beforeAll(async () => {
  mkdirSync(cwd, { recursive: true });
  writeGuardrailChecker(checker);
  script = await import(pathToFileURL(checker.script).href);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function rules(...items: Array<{ id: string; rule: unknown; enabled?: boolean }>) {
  return items.map((item) => ({ enabled: true, ...item }));
}

function writeRules(file: string, items: unknown[]) {
  mkdirSync(checker.dir, { recursive: true });
  writeFileSync(join(checker.dir, file), JSON.stringify({ version: 1, guardrails: items }));
}

/** 真的跑一次检查程序（不继承 Vitest worker 的 execArgv）。 */
function run(input: unknown, args = ['--dir', checker.dir, '--workspace', WORKSPACE]) {
  const result = spawnSync(process.execPath, [checker.script, ...args], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, WEVIR_GATEWAY_TOKEN: 'secret-token' },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'thread-1',
  turn_id: 'turn-1',
  cwd,
  tool_name: 'Bash',
  tool_input: { command },
});

describe('拆命令', () => {
  it('分段、引号、重定向、sh -c 与命令替换', () => {
    const commands = script.commandsOf(
      `FOO=1 sudo -u root rm -rf "my dir" && echo hi > out.txt; bash -lc 'git push --force' | cat $(rm x)`,
    );
    const argvs = commands.map((item: { argv: string[] }) => script.unwrap(item.argv));
    expect(argvs).toContainEqual(['rm', '-rf', 'my dir']);
    expect(argvs).toContainEqual(['git', 'push', '--force']);
    expect(argvs).toContainEqual(['rm', 'x']);
    expect(commands.find((item: { argv: string[] }) => item.argv[0] === 'echo').writes).toEqual([
      'out.txt',
    ]);
  });

  it('heredoc 的正文与 >&2 不算', () => {
    const commands = script.commandsOf('cat <<EOF > notes.md\nrm -rf /\nEOF\necho done >&2');
    const argvs = commands.map((item: { argv: string[] }) => item.argv);
    expect(argvs).toEqual([['cat'], ['echo', 'done']]);
    expect(commands[0].writes).toEqual(['notes.md']);
    expect(commands[1].writes).toEqual([]);
  });
});

describe('禁止命令', () => {
  const prefix = { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' };
  it('前缀按词，程序名只比文件名，包装与子 shell 里的也算', () => {
    expect(script.forbiddenMatch(prefix, 'rm -rf build')).toBe(true);
    expect(script.forbiddenMatch(prefix, '/bin/rm -rf build')).toBe(true);
    expect(script.forbiddenMatch(prefix, 'cd x && sudo env A=1 rm -rf .')).toBe(true);
    expect(script.forbiddenMatch(prefix, 'sh -c "rm -rf ."')).toBe(true);
    expect(script.forbiddenMatch(prefix, 'rm -r build')).toBe(false);
    expect(script.forbiddenMatch(prefix, 'echo rm -rf')).toBe(false);
  });

  it('正则对整条命令；写错的正则不匹配', () => {
    const regex = {
      kind: 'forbidden_command',
      match: 'regex',
      pattern: String.raw`\bgit\s+push\b`,
    };
    expect(script.forbiddenMatch(regex, 'git add . && git  push origin')).toBe(true);
    expect(script.forbiddenMatch(regex, 'git pull')).toBe(false);
    expect(script.forbiddenMatch({ ...regex, pattern: '(' }, 'anything')).toBe(false);
  });
});

describe('保护路径', () => {
  const home = '/home/me';
  const p = (glob: string, target: string) => script.pathProtected(glob, target, cwd, home, false);

  it('不带 / 的 glob 匹配任何一级的名字', () => {
    expect(p('.env*', '.env.local')).toBe(true);
    expect(p('.env*', 'apps/web/.env')).toBe(true);
    expect(p('node_modules', 'node_modules/x/index.js')).toBe(true);
    expect(p('.env*', 'src/env.ts')).toBe(false);
  });

  it('带 / 的相对会话目录，目录也保护里面的东西；绝对与 ~/ 开头的对绝对路径', () => {
    expect(p('secrets/**', 'secrets/a/b.txt')).toBe(true);
    expect(p('secrets', 'secrets/a.txt')).toBe(true);
    expect(p('./config/*.json', join(cwd, 'config', 'app.json'))).toBe(true);
    expect(p('config/*.json', 'config/sub/app.json')).toBe(false);
    expect(p('src/**/*.lock', 'src/a/b/c.lock')).toBe(true);
    expect(p('src/{a,b}.ts', 'src/b.ts')).toBe(true);
    expect(p('~/.ssh', '/home/me/.ssh/id_rsa')).toBe(true);
    expect(p('/etc/**', '/etc/hosts')).toBe(true);
    expect(p('secrets/**', '../secrets/x')).toBe(false);
  });

  it('macOS 与 Windows 不分大小写', () => {
    expect(script.pathProtected('README.md', 'readme.MD', cwd, home, true)).toBe(true);
    expect(script.pathProtected('README.md', 'readme.MD', cwd, home, false)).toBe(false);
  });

  it('命令写到的路径：重定向、rm / mv / cp 的目标、sed -i、tee、dd', () => {
    const targets = (command: string) =>
      script.commandsOf(command).flatMap((item: unknown) => script.writeTargets(item));
    expect(targets('echo x > a.txt 2>/dev/null')).toEqual(['a.txt']);
    expect(targets('rm -f a b && mv c d && cp e f g')).toEqual(['a', 'b', 'c', 'd', 'g']);
    expect(targets("sed -i '' 's/a/b/' f.txt")).toEqual(['f.txt']);
    expect(targets('sed -i -e s/a/b/ f.txt g.txt')).toEqual(['f.txt', 'g.txt']);
    expect(targets('cat x | tee -a log.txt')).toEqual(['log.txt']);
    expect(targets('chmod 600 key.pem')).toEqual(['key.pem']);
    expect(targets('dd if=/dev/zero of=disk.img')).toEqual(['disk.img']);
    expect(targets('cat a.txt && ls')).toEqual([]);
  });

  it('apply_patch 的增删改与改名', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+x',
      '*** Update File: src/b.ts',
      '*** Move to: src/c.ts',
      '@@',
      '*** Delete File: .env',
      '*** End Patch',
    ].join('\n');
    expect(script.patchPaths(patch)).toEqual(['a.txt', 'src/b.ts', 'src/c.ts', '.env']);
  });
});

describe('git commit', () => {
  it('认得出带选项的 git commit，不认 commit 作参数', () => {
    expect(script.isGitCommit('git commit -m x')).toBe(true);
    expect(script.isGitCommit('git -C repo -c user.name=x commit --amend')).toBe(true);
    expect(script.isGitCommit('pnpm lint && git commit -am "fix"')).toBe(true);
    expect(script.isGitCommit('git log --grep commit')).toBe(false);
    expect(script.isGitCommit('echo git commit')).toBe(false);
  });
});

describe('检查程序（真的运行）', () => {
  it('没有规则文件时放行，不输出', () => {
    const result = run(bash('rm -rf /'), ['--dir', join(root, 'missing')]);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('禁止命令：退出码 2，理由给模型，最后一行是标记；关掉的规则与别的项目的规则不算', () => {
    writeRules(
      'global.json',
      rules({
        id: 'grd_g1',
        rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
      }),
    );
    writeRules(
      'ws_01JA2B3C4D5E6F7G8H9JKMNPR5.json',
      rules({
        id: 'grd_other',
        rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'ls' },
      }),
    );
    writeRules(
      `${WORKSPACE}.json`,
      rules(
        {
          id: 'grd_off',
          rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'echo' },
          enabled: false,
        },
        { id: 'grd_p1', rule: { kind: 'protected_path', glob: '.env*' } },
      ),
    );
    const blocked = run(bash('rm -rf build'));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('forbidden command "rm -rf"');
    const [marker] = parseGuardrailMarkers(blocked.stderr);
    expect(marker).toMatchObject({
      guardrailId: 'grd_g1',
      kind: 'forbidden_command',
      action: 'denied',
      tool: 'Bash',
      command: 'rm -rf build',
    });
    expect(blocked.stderr.trimEnd().split('\n').at(-1)?.startsWith(GUARDRAIL_MARKER)).toBe(true);
    expect(run(bash('ls && echo hi')).code).toBe(0);
  });

  it('保护路径：命令写入与 apply_patch 都拦', () => {
    const redirect = run(bash('echo KEY=1 >> .env.local'));
    expect(redirect.code).toBe(2);
    expect(parseGuardrailMarkers(redirect.stderr)[0]).toMatchObject({
      guardrailId: 'grd_p1',
      kind: 'protected_path',
      path: '.env.local',
    });
    const patch = run({
      ...bash(''),
      tool_name: 'apply_patch',
      tool_input: {
        command: '*** Begin Patch\n*** Update File: config/.env\n@@\n-a\n+b\n*** End Patch',
      },
    });
    expect(patch.code).toBe(2);
    expect(parseGuardrailMarkers(patch.stderr)[0]).toMatchObject({
      tool: 'apply_patch',
      path: 'config/.env',
    });
    expect(run(bash('cat .env')).code).toBe(0);
  });

  it('提交前检查：失败拒绝提交（输出带上），通过放行；检查命令看不到 WEVIR_ 变量', () => {
    writeRules(
      `${WORKSPACE}.json`,
      rules({
        id: 'grd_c1',
        rule: { kind: 'commit_check', command: 'echo "token=[$WEVIR_GATEWAY_TOKEN]"; test -f ok' },
      }),
    );
    const failed = run(bash('git commit -m x'));
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('pre-commit check');
    expect(failed.stderr).toContain('token=[]');
    expect(failed.stderr).not.toContain('secret-token');
    expect(parseGuardrailMarkers(failed.stderr)[0]).toMatchObject({
      guardrailId: 'grd_c1',
      kind: 'commit_check',
      action: 'denied',
    });
    expect(run(bash('git status')).code).toBe(0);
    writeFileSync(join(cwd, 'ok'), '');
    expect(run(bash('git commit -m x')).code).toBe(0);
    rmSync(join(cwd, 'ok'));
  });

  it('结束前检查：失败时让 Agent 继续，同一回合到次数上限后放行并报 allowed；换回合重新计数', () => {
    writeRules(
      `${WORKSPACE}.json`,
      rules({
        id: 'grd_s1',
        rule: { kind: 'stop_check', command: 'echo failing >&2; exit 3', maxAttempts: 2 },
      }),
    );
    const stop = (turn: string) =>
      run({
        hook_event_name: 'Stop',
        session_id: 'thread-1',
        turn_id: turn,
        cwd,
        stop_hook_active: false,
      });
    const first = stop('turn-a');
    expect(first.code).toBe(2);
    expect(first.stderr).toContain('attempt 1 of 2');
    expect(first.stderr).toContain('failing');
    expect(parseGuardrailMarkers(first.stderr)[0]).toMatchObject({
      guardrailId: 'grd_s1',
      action: 'continued',
      attempt: 1,
      maxAttempts: 2,
    });
    expect(stop('turn-a').stderr).toContain('attempt 2 of 2');
    const exhausted = stop('turn-a');
    expect(exhausted.code).toBe(0);
    const message = JSON.parse(exhausted.stdout).systemMessage as string;
    expect(parseGuardrailMarkers(message)[0]).toMatchObject({ action: 'allowed', attempt: 2 });
    expect(stop('turn-b').code).toBe(2);
    const state = join(checker.dir, 'state', 'thread-1.json');
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ turnId: 'turn-b' });
    if (process.platform !== 'win32') expect(statSync(state).mode & 0o777).toBe(0o600);
  });

  it('仓库 hook 经它转一手：输入输出与退出码照传，去掉 WEVIR_ 变量，伪造的标记改掉', () => {
    const command = `cat; echo "[$WEVIR_GATEWAY_TOKEN]" >&2; echo '${GUARDRAIL_MARKER}{"guardrailId":"grd_x","kind":"x","action":"denied","reason":"x"}' >&2; exit 2`;
    const result = run({ hello: 1 }, ['--exec', Buffer.from(command).toString('base64')]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('{"hello":1}');
    expect(result.stderr).toContain('[]');
    expect(parseGuardrailMarkers(result.stderr)).toEqual([]);
  });
});

describe('挂哪些 hook', () => {
  it('按规则种类挂 PreToolUse 与 Stop，时限是检查命令的时限之和加余量', () => {
    const hooks = guardrailHooks(
      checker,
      WORKSPACE,
      [
        { kind: 'forbidden_command' },
        { kind: 'stop_check', timeoutSec: 120 },
        { kind: 'stop_check' },
      ],
      'linux',
    );
    expect(hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: GUARDRAIL_TOOL_MATCHER,
        command: guardrailCheckerCommand(
          checker,
          ['--dir', checker.dir, '--workspace', WORKSPACE],
          'linux',
        ),
        timeoutSec: 30,
      },
      { event: 'Stop', command: hooks[0]?.command, timeoutSec: 750 },
    ]);
    expect(guardrailHooks(checker, undefined, [], 'linux')).toEqual([]);
  });

  it('命令行：POSIX 单引号转义，Windows 走 cmd 的 set', () => {
    const quoted = guardrailChecker("/tmp/it's here", '/usr/bin/node');
    expect(guardrailCheckerCommand(quoted, ['--dir', quoted.dir], 'darwin')).toBe(
      `ELECTRON_RUN_AS_NODE=1 exec '/usr/bin/node' '/tmp/it'\\''s here/bin/wevir-guardrail.mjs' '--dir' '/tmp/it'\\''s here'`,
    );
    const win = guardrailChecker('C:\\Wevir\\guardrails', 'C:\\Wevir\\Wevir.exe');
    expect(repoHookCommand(win, 'echo hi', 'win32')).toMatch(
      /^set "ELECTRON_RUN_AS_NODE=1" && "C:\\Wevir\\Wevir.exe" ".+wevir-guardrail\.mjs" "--exec" "ZWNobyBoaQ=="$/,
    );
  });

  it('脚本 0600', () => {
    if (process.platform !== 'win32') expect(statSync(checker.script).mode & 0o777).toBe(0o600);
  });
});
