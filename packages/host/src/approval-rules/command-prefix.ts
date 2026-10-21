// 命令前缀规则的匹配（domain-model §3.35）：把一条 shell 命令拆成若干条只含字面词的命令，每一条都以某条规则的前缀开头，
// 才算被规则允许。做法照 Codex 的 execpolicy（codex-rs shell-command/src/bash.rs 的 `try_parse_word_only_commands_sequence`，
// rust-v0.162.1）：只认 `&&`、`||`、`;`、`|` 连起来的普通命令，词只能是字面量（裸词、单引号、不含展开的双引号）；变量与命令
// 替换、重定向、子 shell、通配符、后台 `&`、环境变量赋值等一律当作认不出，认不出就不匹配，照常问用户。Codex 用 tree-sitter，
// 这里手写同一个子集，宁可多问不可错放。
//
// `bash -lc '<脚本>'` 这类外壳（Codex 的命令原文就带）拆一层，按里面的脚本匹配。

/** 外壳：`<shell> -c|-lc <脚本>`，按脚本匹配（codex-rs shell-command/src/bash.rs 的 `extract_bash_command`）。 */
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash']);
const SHELL_SCRIPT_FLAGS = new Set(['-c', '-lc']);

/** 词里出现就认不出的字符：展开、通配、重定向、分组、历史与注释。 */
const UNSAFE_BARE = new Set([
  '$',
  '`',
  '(',
  ')',
  '{',
  '}',
  '<',
  '>',
  '*',
  '?',
  '[',
  ']',
  '!',
  '#',
  '~',
]);

type Token = { word: string } | { op: '&&' | '||' | ';' | '|' };

function tokenize(script: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i] as string;
    if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === '\n' || c === ';') {
      endWord();
      tokens.push({ op: ';' });
    } else if (c === '&') {
      if (script[i + 1] !== '&') return null;
      endWord();
      tokens.push({ op: '&&' });
      i++;
    } else if (c === '|') {
      endWord();
      if (script[i + 1] === '|') {
        tokens.push({ op: '||' });
        i++;
      } else if (script[i + 1] === '&') {
        return null;
      } else {
        tokens.push({ op: '|' });
      }
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + script.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let text = '';
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        const d = script[j] as string;
        if (d === '$' || d === '`') return null;
        if (d === '\\') {
          const next = script[j + 1];
          if (next === undefined) return null;
          if (next === '"' || next === '\\') {
            text += next;
            j++;
            continue;
          }
          if (next === '$' || next === '`' || next === '\n') return null;
        }
        text += d;
      }
      if (j >= script.length) return null;
      word = (word ?? '') + text;
      i = j;
    } else if (c === '\\') {
      const next = script[i + 1];
      if (next === undefined || next === '\n') return null;
      word = (word ?? '') + next;
      i++;
    } else {
      if (UNSAFE_BARE.has(c)) return null;
      word = (word ?? '') + c;
    }
  }
  endWord();
  return tokens;
}

/** 拆成普通命令（每条是 argv）；认不出返回 null。 */
export function splitShellCommand(command: string): string[][] | null {
  return split(command, true);
}

function split(script: string, unwrap: boolean): string[][] | null {
  const tokens = tokenize(script);
  if (tokens === null) return null;
  const commands: string[][] = [];
  let current: string[] = [];
  let pendingOp: string | null = null;
  for (const token of tokens) {
    if ('word' in token) {
      // 命令开头的 `NAME=value` 是环境变量赋值，会改变后面程序的行为（例如 `GIT_DIR=`）。
      if (current.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.word)) return null;
      current.push(token.word);
      pendingOp = null;
      continue;
    }
    if (current.length === 0) {
      // `;` 可以连写或出现在开头（空行），其余运算符两边都要有命令。
      if (token.op !== ';' || (pendingOp !== null && pendingOp !== ';')) return null;
      continue;
    }
    commands.push(current);
    current = [];
    pendingOp = token.op;
  }
  if (current.length > 0) commands.push(current);
  else if (pendingOp !== null && pendingOp !== ';') return null;
  if (commands.length === 0) return null;
  if (unwrap && commands.length === 1) {
    const [argv] = commands as [string[]];
    const shell = basename(argv[0] as string);
    if (
      argv.length === 3 &&
      SHELL_WRAPPERS.has(shell) &&
      SHELL_SCRIPT_FLAGS.has(argv[1] as string)
    ) {
      return split(argv[2] as string, false);
    }
  }
  return commands;
}

function basename(program: string): string {
  const parts = program.split(/[\\/]/);
  return parts[parts.length - 1] ?? program;
}

export function startsWithPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((token, i) => argv[i] === token);
}

/**
 * 命令里每一条都以某个前缀开头时，返回各条用到的前缀的下标（去重）；否则 null。
 */
export function matchCommandPrefixes(
  command: string,
  prefixes: readonly (readonly string[])[],
): number[] | null {
  const commands = splitShellCommand(command);
  if (commands === null) return null;
  const used = new Set<number>();
  for (const argv of commands) {
    const index = prefixes.findIndex((prefix) => startsWithPrefix(argv, prefix));
    if (index < 0) return null;
    used.add(index);
  }
  return [...used];
}

/**
 * 不提议作前缀的：解释器与外壳（前缀之后可以跑任意代码）、包一层再跑别的程序的命令，以及 Codex 的
 * `BANNED_PREFIX_SUGGESTIONS`（codex-rs core/src/exec_policy.rs）里的其余几条。只禁止恰好等于这些的前缀，
 * 更长的（如 `npm run test`）可以。
 */
const BANNED_PREFIXES: readonly (readonly string[])[] = [
  ...['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh'].flatMap((shell) => [
    [shell],
    [shell, '-c'],
    [shell, '-lc'],
  ]),
  ...['python', 'python3', 'py', 'pypy', 'pypy3', 'pythonw', 'pyw'].flatMap((p) => [
    [p],
    [p, '-c'],
    [p, '-'],
    [p, '-m'],
  ]),
  ...['node', 'nodejs'].flatMap((p) => [[p], [p, '-e']]),
  ...['perl', 'ruby', 'lua', 'julia', 'php', 'Rscript', 'deno', 'bun', 'osascript'].map((p) => [p]),
  ['perl', '-e'],
  ['ruby', '-e'],
  ['lua', '-e'],
  ['julia', '-e'],
  ['php', '-r'],
  ['deno', 'eval'],
  ['deno', 'run'],
  ['bun', '-e'],
  ['bun', 'run'],
  ['bun', 'x'],
  ['bunx'],
  ['npx'],
  ['pnpx'],
  ['npm', 'exec'],
  ['npm', 'run'],
  ['npm', 'x'],
  ['pnpm', 'run'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['yarn', 'run'],
  ['yarn', 'exec'],
  ['yarn', 'dlx'],
  ['uv', 'run'],
  ['uvx'],
  ['cargo', 'run'],
  ['go', 'run'],
  ['make'],
  ...['pwsh', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe'].map((p) => [p]),
  ...[
    'sudo',
    'su',
    'doas',
    'env',
    'eval',
    'exec',
    'xargs',
    'nohup',
    'nice',
    'timeout',
    'time',
    'command',
    'builtin',
    'watch',
  ].map((p) => [p]),
  ['git'],
  ['rm'],
  ['find'],
  ['awk'],
  ['sed'],
];

function isBanned(prefix: readonly string[]): boolean {
  return BANNED_PREFIXES.some(
    (banned) => banned.length === prefix.length && banned.every((t, i) => t === prefix[i]),
  );
}

/** 前缀之后可以接任意程序的命令：不提议任何以它们开头的前缀。 */
const RUNS_OTHER_PROGRAMS = new Set([
  'sudo',
  'su',
  'doas',
  'env',
  'eval',
  'exec',
  'xargs',
  'nohup',
  'nice',
  'timeout',
  'time',
  'command',
  'builtin',
  'watch',
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'pwsh',
  'powershell',
  'powershell.exe',
  'cmd',
  'cmd.exe',
  // 解释器与能执行命令的文本工具：参数就是程序（`python3 -c …`、awk 的 `system()`、sed 的 `e`、`find -exec`）。
  'python',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'pythonw',
  'pyw',
  'node',
  'nodejs',
  'perl',
  'ruby',
  'lua',
  'julia',
  'php',
  'Rscript',
  'osascript',
  'awk',
  'gawk',
  'sed',
  'find',
]);

/**
 * 删改文件、进程或发往别处的命令：参数决定它做什么，前缀之后多接一个参数就可能是另一回事（`rm build` 之后接 `-rf ~`），
 * 不提议。
 */
const DESTRUCTIVE = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'dd',
  'mkfs',
  'mv',
  'cp',
  'ln',
  'tee',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'killall',
  'pkill',
  'shutdown',
  'reboot',
  'halt',
  'launchctl',
  'diskutil',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
]);

/** 有子命令的工具：提议到子命令为止（`git status …`）。 */
const SUBCOMMAND_TOOLS = new Set([
  'git',
  'gh',
  'glab',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'go',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'uv',
  'pip',
  'pip3',
  'poetry',
  'brew',
  'swift',
  'dotnet',
  'gradle',
  'mvn',
  'terraform',
  'rustup',
  'deno',
  'wevir',
]);

/** 子命令：看起来像一个词，不是选项、路径或参数。 */
function isSubcommandWord(token: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:-]*$/.test(token) && token.length <= 40;
}

/**
 * 给一条普通命令提议前缀（审批卡片的“总是允许”与从历史建议规则共用）：有子命令的工具取到子命令（`git status`；
 * 被禁止的两段式再多取一段，如 `npm run test`），其余取完整命令。返回 null 表示不提议。
 */
export function proposePrefix(argv: readonly string[]): string[] | null {
  const program = argv[0];
  if (program === undefined) return null;
  const name = basename(program);
  if (RUNS_OTHER_PROGRAMS.has(name) || DESTRUCTIVE.has(name)) return null;
  let prefix: string[];
  if (SUBCOMMAND_TOOLS.has(program)) {
    prefix = [program];
    for (const token of argv.slice(1)) {
      if (!isSubcommandWord(token)) break;
      prefix.push(token);
      if (!isBanned(prefix)) break;
    }
    // 只有工具名（`npm`）等于允许它的所有子命令。
    if (prefix.length === 1) return null;
  } else {
    prefix = [...argv];
  }
  return isBanned(prefix) ? null : prefix;
}

/**
 * 能不能作规则的前缀（`approvalRule.add` 与采用引擎的提议时）：与 `proposePrefix` 同一套限制——不以包一层跑别的程序或删改类
 * 命令开头，不恰好是被禁止的前缀，有子命令的工具要带上子命令。
 */
export function isAcceptablePrefix(prefix: readonly string[]): boolean {
  const program = prefix[0];
  if (program === undefined) return false;
  const name = basename(program);
  if (RUNS_OTHER_PROGRAMS.has(name) || DESTRUCTIVE.has(name) || isBanned(prefix)) return false;
  return !(SUBCOMMAND_TOOLS.has(program) && prefix.length === 1);
}

/**
 * 给一条 shell 命令提议规则：每一条没被已有前缀允许的普通命令各提议一个前缀（去重）。有一条提议不出来就整体不提议；
 * 全部已被允许也返回空数组之外的 null（没有可提议的）。
 */
export function proposePrefixesForCommand(
  command: string,
  existing: readonly (readonly string[])[] = [],
): string[][] | null {
  const commands = splitShellCommand(command);
  if (commands === null) return null;
  const proposals: string[][] = [];
  for (const argv of commands) {
    if (existing.some((prefix) => startsWithPrefix(argv, prefix))) continue;
    if (proposals.some((prefix) => startsWithPrefix(argv, prefix))) continue;
    const prefix = proposePrefix(argv);
    if (prefix === null) return null;
    proposals.push(prefix);
  }
  return proposals.length > 0 ? proposals : null;
}

/** 显示用：`git status`。含空白或引号的词加单引号。 */
export function formatPrefix(prefix: readonly string[]): string {
  return prefix
    .map((token) =>
      /^[A-Za-z0-9._:@%+=,/-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}
