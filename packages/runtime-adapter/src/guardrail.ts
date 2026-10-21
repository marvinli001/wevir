import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EngineHook } from './types.js';

// 护栏的检查程序（0.86.0，domain-model §3.40）：Host 把它写进数据目录，作为引擎的命令 hook 挂到会话上（Codex 的 PreToolUse / Stop，
// stdin 是事件的 JSON，Claude Code 同一套写法）。它每次被调用时读 `<数据目录>/guardrails/` 里全局的与这个项目的规则文件，判定放行还是
// 拦下：拦下时退出码 2、理由写 stderr（Codex 把它交给模型：PreToolUse 拒绝这一步，Stop 让 Agent 接着做），理由的最后一行是给 Wevir
// 的标记（`wevir-guardrail: {…}`），适配器从引擎的 hook 结果里认出它、报 `guardrail.blocked`。标记只能靠 stderr 带：退出码 2 时
// Codex 不看 stdout，而登录 shell 的启动脚本可能往 stdout 写东西，用 JSON 输出会让拦截失效（Codex 对解析不了的输出一律放行）。
// 结束前检查到了次数上限放行时退出码 0，标记放在 stdout 的 `systemMessage` 里（解析失败也只是少一条事件）。
//
// 仓库自带、用户启用了的 hook 也经它转一手（`--exec`）：去掉 `WEVIR_*` 与 `ELECTRON_RUN_AS_NODE` 再跑，输出里伪造的标记行被改掉。
// 检查命令同样在去掉这些变量的环境里跑（app-server 的环境里有网关令牌）。
//
// 脚本只用 Node 内置模块，由 Host 自己的 Node 运行（Electron 里带 `ELECTRON_RUN_AS_NODE=1`）。它同时是个 ES 模块：测试 import 它
// 拿到判定用的函数。

/** 标记行的前缀。 */
export const GUARDRAIL_MARKER = 'wevir-guardrail: ';

/** 标记里的内容（与协议的 `GuardrailBlocked` 同形，少了 `turnId`）。 */
export interface GuardrailMarker {
  guardrailId: string;
  kind: string;
  action: string;
  tool?: string;
  command?: string;
  path?: string;
  reason: string;
  attempt?: number;
  maxAttempts?: number;
}

/** 从 hook 的输出里找出标记（每行一个）。形状不对的丢掉。 */
export function parseGuardrailMarkers(text: string): GuardrailMarker[] {
  const markers: GuardrailMarker[] = [];
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(GUARDRAIL_MARKER);
    if (at < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(at + GUARDRAIL_MARKER.length));
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const marker = value as Record<string, unknown>;
    if (
      typeof marker.guardrailId !== 'string' ||
      typeof marker.kind !== 'string' ||
      typeof marker.action !== 'string' ||
      typeof marker.reason !== 'string'
    ) {
      continue;
    }
    const text = (key: string) => (typeof marker[key] === 'string' ? marker[key] : undefined);
    const int = (key: string) =>
      Number.isInteger(marker[key]) && (marker[key] as number) > 0
        ? (marker[key] as number)
        : undefined;
    const tool = text('tool');
    const command = text('command');
    const path = text('path');
    const attempt = int('attempt');
    const maxAttempts = int('maxAttempts');
    markers.push({
      guardrailId: marker.guardrailId,
      kind: marker.kind,
      action: marker.action,
      ...(tool !== undefined && { tool }),
      ...(command !== undefined && { command }),
      ...(path !== undefined && { path }),
      reason: marker.reason,
      ...(attempt !== undefined && { attempt }),
      ...(maxAttempts !== undefined && { maxAttempts }),
    });
  }
  return markers;
}

/**
 * 检查程序。`String.raw`：正文里的反斜杠原样保留；正文里不能出现反引号与 `${`。
 */
export const GUARDRAIL_CHECKER_SCRIPT = String.raw`// 由 Wevir 生成（packages/runtime-adapter/src/guardrail.ts），Host 每次启动时重写，不要手改。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'wevir-guardrail: ';
const TEXT_MAX = 2000;
const OUTPUT_TAIL = 3000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_ID = /^ws_[0-9A-Za-z]{1,64}$/;

function clipHead(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

function clipTail(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : '…' + chars.slice(chars.length - max + 1).join('');
}

// ── 拆命令 ──────────────────────────────────────────────────────────────

/** 词与操作符。引号与转义去掉；heredoc 的正文跳过；注释到行尾。 */
export function tokenize(command) {
  const out = [];
  const len = command.length;
  let cur = null;
  let i = 0;
  const push = () => {
    if (cur !== null) {
      out.push({ word: cur });
      cur = null;
    }
  };
  const heredocs = [];
  while (i < len) {
    const c = command[i];
    if (c === '\\') {
      if (i + 1 < len && command[i + 1] !== '\n') cur = (cur ?? '') + command[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? len : end;
      cur = (cur ?? '') + command.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < len && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < len && '"\\$\n'.includes(command[j + 1])) {
          buf += command[j + 1];
          j += 2;
        } else {
          buf += command[j];
          j += 1;
        }
      }
      cur = (cur ?? '') + buf;
      i = j + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      i += 1;
      continue;
    }
    if (c === '\n') {
      push();
      out.push({ op: ';' });
      i += 1;
      // heredoc 的正文：到只有分隔词的那一行为止。
      while (heredocs.length > 0) {
        const delimiter = heredocs.shift();
        for (;;) {
          if (i >= len) break;
          const nl = command.indexOf('\n', i);
          const line = command.slice(i, nl < 0 ? len : nl);
          i = nl < 0 ? len : nl + 1;
          if (line.replace(/^\t+/, '') === delimiter) break;
        }
      }
      continue;
    }
    if (c === ';' || c === '(' || c === ')' || c === '{' && cur === null || c === '}' && cur === null) {
      push();
      out.push({ op: c === '{' || c === '}' ? ';' : c });
      i += 1;
      continue;
    }
    if (c === '#' && cur === null) {
      const nl = command.indexOf('\n', i);
      i = nl < 0 ? len : nl;
      continue;
    }
    if (c === '&' || c === '|') {
      push();
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') {
        out.push({ op: two });
        i += 2;
      } else if (two === '&>') {
        const op = command[i + 2] === '>' ? '&>>' : '&>';
        out.push({ op: 'redir', write: true });
        i += op.length;
      } else {
        out.push({ op: c });
        i += 1;
      }
      continue;
    }
    if (c === '>' || c === '<') {
      if (cur !== null && /^\d+$/.test(cur)) cur = null;
      else push();
      if (c === '<' && command[i + 1] === '<') {
        // heredoc：记下分隔词，正文在下一个换行之后。
        let j = i + 2;
        if (command[j] === '-') j += 1;
        if (command[j] === '<') {
          // here-string：后面的词是输入，不是文件。
          i = j + 1;
          out.push({ op: 'redir', write: false });
          continue;
        }
        while (command[j] === ' ' || command[j] === '\t') j += 1;
        let k = j;
        while (k < len && !' \t\n;&|<>()'.includes(command[k])) k += 1;
        heredocs.push(command.slice(j, k).replace(/['"\\]/g, ''));
        i = k;
        continue;
      }
      let op = c;
      if (command[i + 1] === '>' || command[i + 1] === '&' || command[i + 1] === '|') op = c + command[i + 1];
      out.push({ op: 'redir', write: c === '>', dup: command[i + 1] === '&' });
      i += op.length;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      // 命令替换：括号里的另作一条命令拆（结果一并检查），这里只留一个占位词。
      let depth = 1;
      let j = i + 2;
      while (j < len && depth > 0) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
        j += 1;
      }
      out.push({ nested: command.slice(i + 2, j - 1) });
      cur = (cur ?? '') + '$()';
      i = j;
      continue;
    }
    if (c === '\u0060') {
      const end = command.indexOf('\u0060', i + 1);
      const stop = end < 0 ? len : end;
      out.push({ nested: command.slice(i + 1, stop) });
      cur = (cur ?? '') + '$()';
      i = stop + 1;
      continue;
    }
    cur = (cur ?? '') + c;
    i += 1;
  }
  push();
  return out;
}

/** 拆成一条条简单命令：词、写入的重定向目标；命令替换与 sh -c 里的另算（最多三层）。 */
export function commandsOf(command, depth = 0) {
  const commands = [];
  let current = { argv: [], writes: [] };
  let pendingRedirect = null;
  const finish = () => {
    if (current.argv.length > 0 || current.writes.length > 0) commands.push(current);
    current = { argv: [], writes: [] };
  };
  const nested = [];
  for (const token of tokenize(command)) {
    if (token.nested !== undefined) {
      nested.push(token.nested);
      continue;
    }
    if (token.op === 'redir') {
      pendingRedirect = token;
      continue;
    }
    if (token.op !== undefined) {
      pendingRedirect = null;
      finish();
      continue;
    }
    if (pendingRedirect !== null) {
      const target = token.word;
      if (pendingRedirect.write && !(pendingRedirect.dup && /^(\d+|-)$/.test(target))) {
        current.writes.push(target);
      }
      pendingRedirect = null;
      continue;
    }
    current.argv.push(token.word);
  }
  finish();
  if (depth < 3) {
    const scripts = [...nested];
    for (const item of commands) {
      const script = shellScriptOf(unwrap(item.argv));
      if (script !== undefined) scripts.push(script);
    }
    for (const script of scripts) commands.push(...commandsOf(script, depth + 1));
  }
  return commands;
}

function programName(word) {
  const name = basename(word.replace(/\\/g, '/'));
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name;
}

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'xargs']);
const WRAPPER_VALUE_FLAGS = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-D'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  ionice: ['-c', '-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'],
};

/** 去掉开头的变量赋值与 sudo、env 一类的包装，程序名只留文件名。 */
export function unwrap(argv) {
  let rest = [...argv];
  for (let guard = 0; guard < 8; guard += 1) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    if (rest.length === 0) return rest;
    const name = programName(rest[0]);
    if (!WRAPPERS.has(name)) return [name, ...rest.slice(1)];
    rest = rest.slice(1);
    const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? [];
    while (rest.length > 0 && (rest[0].startsWith('-') || name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
      const flag = rest[0];
      rest = rest.slice(1);
      if (valueFlags.includes(flag) && rest.length > 0) rest = rest.slice(1);
      if (flag === '--') break;
    }
    // timeout 的时长。
    if (name === 'timeout' && rest.length > 0 && /^[0-9.]+[smhd]?$/.test(rest[0])) rest = rest.slice(1);
  }
  return rest.length > 0 ? [programName(rest[0]), ...rest.slice(1)] : rest;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);

/** sh -c '<脚本>'、eval '<脚本>' 的脚本。 */
function shellScriptOf(argv) {
  if (argv.length === 0) return undefined;
  if (argv[0] === 'eval') return argv.slice(1).join(' ');
  if (!SHELLS.has(argv[0])) return undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return argv[i + 1];
  }
  return undefined;
}

// ── 规则 ────────────────────────────────────────────────────────────────

/** 禁止命令：前缀按词比较（程序名只比文件名），正则对整条命令。 */
export function forbiddenMatch(rule, command) {
  if (rule.match === 'regex') {
    let re;
    try {
      re = new RegExp(rule.pattern);
    } catch {
      return false;
    }
    return re.test(command);
  }
  const prefix = (commandsOf(rule.pattern)[0]?.argv ?? []).map((word, index) => (index === 0 ? programName(word) : word));
  if (prefix.length === 0) return false;
  return commandsOf(command).some((item) => {
    const argv = unwrap(item.argv);
    return argv.length >= prefix.length && prefix.every((word, index) => argv[index] === word);
  });
}

const WRITE_ALL = new Set(['rm', 'rmdir', 'unlink', 'touch', 'truncate', 'mkdir', 'chmod', 'chown', 'chgrp', 'mv', 'shred', 'tee']);
const WRITE_LAST = new Set(['cp', 'ln', 'install', 'rsync', 'scp']);

/** 不是选项的参数；valueFlags 里的选项连同它的值一起跳过。 */
function positional(args, valueFlags = []) {
  const out = [];
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (valueFlags.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** 一条命令会写的路径（尽力而为）：重定向目标、rm / mv / cp 等的参数、sed -i 的文件、dd 的 of=。 */
export function writeTargets(item) {
  const targets = [...item.writes];
  const argv = unwrap(item.argv);
  if (argv.length === 0) return targets;
  const [name, ...args] = argv;
  if (WRITE_ALL.has(name)) {
    const files = positional(args);
    // chmod / chown 的第一个参数是模式或属主。
    targets.push(...(name === 'chmod' || name === 'chown' || name === 'chgrp' ? files.slice(1) : files));
  } else if (WRITE_LAST.has(name)) {
    const files = positional(args);
    if (files.length > 1) targets.push(files[files.length - 1]);
  } else if ((name === 'sed' || name === 'perl') && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))) {
    // BSD sed 的 -i '' 是备份后缀，不是脚本。
    const files = positional(args, ['-e', '-f', '--expression', '--file']).filter((arg) => arg !== '');
    const scripted = args.some((arg) => arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file');
    targets.push(...(scripted ? files : files.slice(1)));
  } else if (name === 'dd') {
    for (const arg of args) if (arg.startsWith('of=')) targets.push(arg.slice(3));
  }
  return targets.filter((target) => target !== '' && target !== '/dev/null' && !target.includes('$()'));
}

/** apply_patch 改到的路径：增、删、改与改名的目标。 */
export function patchPaths(patch) {
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

/** glob → 正则：** 跨目录，* 与 ? 不跨，[...] 照用，{a,b} 是择一。 */
export function globRegExp(glob, ignoreCase) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) {
        re += '\\{';
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|') + ')';
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|\\/]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function slashes(path) {
  return path.replace(/\\/g, '/');
}

/** 路径或它所在的某一级目录匹配。 */
function selfOrAncestorMatches(re, path) {
  const parts = path.split('/');
  for (let n = parts.length; n > 0; n -= 1) {
    if (re.test(parts.slice(0, n).join('/'))) return true;
  }
  return false;
}

/**
 * 保护路径：不带 / 的 glob 匹配任何一级的名字（.env、node_modules）；以 / 或 ~/ 开头的匹配绝对路径；其余相对会话目录，目录的
 * glob 也保护目录里的东西。
 */
export function pathProtected(glob, target, cwd, home, ignoreCase) {
  let pattern = slashes(glob.trim());
  const expanded = target.startsWith('~/') ? join(home, target.slice(2)) : target;
  const abs = slashes(resolve(cwd, expanded));
  if (pattern.startsWith('~/')) pattern = slashes(home) + pattern.slice(1);
  if (pattern.startsWith('./')) pattern = pattern.slice(2);
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  if (pattern === '') return false;
  if (pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) {
    return selfOrAncestorMatches(globRegExp(pattern, ignoreCase), abs);
  }
  const rel = slashes(relative(cwd, abs));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  if (!pattern.includes('/')) {
    const re = globRegExp(pattern, ignoreCase);
    return (inside ? rel : abs).split('/').some((part) => part !== '' && re.test(part));
  }
  return inside && selfOrAncestorMatches(globRegExp(pattern, ignoreCase), rel);
}

/** 这条命令里有没有 git commit（git -C、-c 一类的选项之后）。 */
export function isGitCommit(command) {
  return commandsOf(command).some((item) => {
    const argv = unwrap(item.argv);
    if (argv[0] !== 'git') return false;
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
        i += 1;
        continue;
      }
      if (arg.startsWith('-')) continue;
      return arg === 'commit';
    }
    return false;
  });
}

/**
 * 执行工具前（PreToolUse）不用跑命令的判定：禁止命令与保护路径。拦下时给出规则与命中的命令或路径，否则 undefined。
 */
export function evaluateTool(rules, input, options) {
  const tool = input.tool_name;
  const raw = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : undefined;
  if (raw === undefined) return undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (tool === 'Bash') {
    for (const rule of rules) {
      if (rule.rule.kind === 'forbidden_command' && forbiddenMatch(rule.rule, raw)) {
        return { rule, command: raw };
      }
    }
    const targets = commandsOf(raw).flatMap(writeTargets);
    for (const rule of rules) {
      if (rule.rule.kind !== 'protected_path') continue;
      const hit = targets.find((target) => pathProtected(rule.rule.glob, target, cwd, options.home, options.ignoreCase));
      if (hit !== undefined) return { rule, command: raw, path: hit };
    }
    return undefined;
  }
  if (tool === 'apply_patch') {
    const paths = patchPaths(raw);
    for (const rule of rules) {
      if (rule.rule.kind !== 'protected_path') continue;
      const hit = paths.find((target) => pathProtected(rule.rule.glob, target, cwd, options.home, options.ignoreCase));
      if (hit !== undefined) return { rule, path: hit };
    }
  }
  return undefined;
}

// ── 运行 ────────────────────────────────────────────────────────────────

/** 检查命令与仓库 hook 的环境：去掉 Wevir 的变量（网关令牌）与 Electron 的开关。 */
export function scrubbedEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^WEVIR_/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function runCheck(command, cwd, timeoutSec) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    env: scrubbedEnv(process.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutSec * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  const timedOut = result.error !== undefined && result.error.code === 'ETIMEDOUT';
  return { ok: result.status === 0 && result.error === undefined, exitCode: result.status, timedOut, output };
}

function loadRules(dir, workspaceId) {
  const files = [join(dir, 'global.json')];
  if (workspaceId !== undefined && WORKSPACE_ID.test(workspaceId)) files.push(join(dir, workspaceId + '.json'));
  const rules = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.guardrails)) continue;
    for (const item of parsed.guardrails) {
      if (item === null || typeof item !== 'object' || item.enabled !== true) continue;
      if (typeof item.id !== 'string' || item.rule === null || typeof item.rule !== 'object') continue;
      rules.push(item);
    }
  }
  return rules;
}

function marker(fields) {
  return MARKER + JSON.stringify(fields);
}

/** 拦下：退出码 2，理由与标记写 stderr。 */
function block(reason, fields) {
  return { exitCode: 2, stderr: reason + '\n' + marker({ ...fields, reason: clipHead(reason, TEXT_MAX) }) + '\n' };
}

function preToolUse(rules, input) {
  const hit = evaluateTool(rules, input, {
    home: homedir(),
    ignoreCase: process.platform === 'darwin' || process.platform === 'win32',
  });
  const tool = input.tool_name;
  if (hit !== undefined) {
    const rule = hit.rule.rule;
    const reason =
      rule.kind === 'forbidden_command'
        ? 'Blocked by a Wevir guardrail: this command matches the forbidden ' +
          (rule.match === 'regex' ? 'pattern /' + rule.pattern + '/' : 'command "' + rule.pattern + '"') +
          '. Do not work around it; if the command is required, ask the user.'
        : 'Blocked by a Wevir guardrail: ' + hit.path + ' is protected (' + rule.glob + '). Do not modify it; if the change is required, ask the user.';
    return block(reason, {
      guardrailId: hit.rule.id,
      kind: rule.kind,
      action: 'denied',
      tool,
      ...(hit.command !== undefined && { command: clipHead(hit.command, TEXT_MAX) }),
      ...(hit.path !== undefined && { path: clipHead(hit.path, TEXT_MAX) }),
    });
  }
  const raw = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : undefined;
  if (tool !== 'Bash' || raw === undefined || !isGitCommit(raw)) return undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  for (const rule of rules) {
    if (rule.rule.kind !== 'commit_check') continue;
    const result = runCheck(rule.rule.command, cwd, rule.rule.timeoutSec ?? 600);
    if (result.ok) continue;
    const status = result.timedOut ? 'timed out' : 'failed (exit ' + result.exitCode + ')';
    const reason =
      'Blocked by a Wevir guardrail: the pre-commit check "' + rule.rule.command + '" ' + status +
      ', so this commit was not made. Fix the problems, then commit again.\n' + clipTail(result.output, OUTPUT_TAIL);
    return block(reason, { guardrailId: rule.id, kind: 'commit_check', action: 'denied', tool, command: clipHead(raw, TEXT_MAX) });
  }
  return undefined;
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, file);
  } catch {}
}

function stop(rules, input, dir) {
  const checks = rules.filter((rule) => rule.rule.kind === 'stop_check');
  if (checks.length === 0) return undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const sessionId = typeof input.session_id === 'string' && SESSION_ID.test(input.session_id) ? input.session_id : undefined;
  const turnId = typeof input.turn_id === 'string' ? input.turn_id : '';
  const stateFile = sessionId === undefined ? undefined : join(dir, 'state', sessionId + '.json');
  let state = stateFile === undefined ? {} : readState(stateFile);
  if (state.turnId !== turnId || state.attempts === null || typeof state.attempts !== 'object') {
    state = { turnId, attempts: {} };
  }
  const allowed = [];
  for (const rule of checks) {
    const result = runCheck(rule.rule.command, cwd, rule.rule.timeoutSec ?? 600);
    if (result.ok) continue;
    const maxAttempts = rule.rule.maxAttempts ?? 3;
    const used = Number.isInteger(state.attempts[rule.id]) ? state.attempts[rule.id] : 0;
    const status = result.timedOut ? 'timed out' : 'failed (exit ' + result.exitCode + ')';
    if (used >= maxAttempts) {
      allowed.push({
        guardrailId: rule.id,
        kind: 'stop_check',
        action: 'allowed',
        command: clipHead(rule.rule.command, TEXT_MAX),
        reason: clipHead('The check "' + rule.rule.command + '" still ' + status + ' after ' + maxAttempts + ' attempts; the turn was allowed to finish.', TEXT_MAX),
        attempt: used,
        maxAttempts,
      });
      continue;
    }
    state.attempts[rule.id] = used + 1;
    if (stateFile !== undefined) writeState(stateFile, state);
    const reason =
      'A Wevir guardrail requires the check "' + rule.rule.command + '" to pass before you finish, and it ' + status +
      ' (attempt ' + (used + 1) + ' of ' + maxAttempts + '). Fix the problems and run the check again before finishing.\n' +
      clipTail(result.output, OUTPUT_TAIL);
    return block(reason, {
      guardrailId: rule.id,
      kind: 'stop_check',
      action: 'continued',
      command: clipHead(rule.rule.command, TEXT_MAX),
      attempt: used + 1,
      maxAttempts,
    });
  }
  if (allowed.length === 0) return undefined;
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: allowed.map(marker).join('\n') }) + '\n' };
}

/** 用户启用的仓库 hook：去掉 Wevir 的变量再跑，输出原样转回（伪造的标记行改掉），退出码照传。 */
function execHook(command, stdin) {
  const result = spawnSync(command, {
    shell: true,
    env: scrubbedEnv(process.env),
    input: stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const defang = (text) => (text ?? '').toString().split(MARKER).join('wevir-guardrail (repo hook): ');
  return { exitCode: result.status ?? 1, stdout: defang(result.stdout), stderr: defang(result.stderr) };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 判定一次调用：返回退出码与要写的输出；放行且没什么可说时 undefined。 */
export function decide(argv, stdin) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (args['--exec'] !== undefined) return execHook(Buffer.from(args['--exec'], 'base64').toString('utf8'), stdin);
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  const dir = args['--dir'];
  if (typeof dir !== 'string' || input === null || typeof input !== 'object') return undefined;
  const rules = loadRules(dir, args['--workspace']);
  if (input.hook_event_name === 'PreToolUse') return preToolUse(rules, input);
  if (input.hook_event_name === 'Stop') return stop(rules, input, dir);
  return undefined;
}

export async function main(argv) {
  const result = decide(argv, await readStdin());
  if (result === undefined) return;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

function isEntry() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntry()) await main(process.argv.slice(2));
`;

/** 检查程序的位置（脚本在 `<dir>/bin/wevir-guardrail.mjs`，规则文件在 `<dir>`）。 */
export interface GuardrailChecker {
  /** 规则文件所在的目录（`<数据目录>/guardrails`）。 */
  dir: string;
  script: string;
  /** 默认 `process.execPath`（Host 自己的 Node；Electron 里是 Electron，靠 `ELECTRON_RUN_AS_NODE`）。 */
  node: string;
}

export function guardrailChecker(dir: string, node = process.execPath): GuardrailChecker {
  return { dir, script: join(dir, 'bin', 'wevir-guardrail.mjs'), node };
}

/** 写脚本（0600，覆盖）。Host 启动时调用，可重复。 */
export function writeGuardrailChecker(checker: GuardrailChecker): void {
  mkdirSync(dirname(checker.script), { recursive: true, mode: 0o700 });
  writeFileSync(checker.script, GUARDRAIL_CHECKER_SCRIPT, { mode: 0o600 });
  chmodSync(checker.script, 0o600);
}

/** 一个参数给 shell：POSIX 用单引号；Windows 的 cmd 用双引号（路径里不会有双引号）。 */
function quote(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 让 shell 运行检查程序的整条命令行（Codex 用 `$SHELL -lc` 或 `cmd /C` 跑它）。 */
export function guardrailCheckerCommand(
  checker: GuardrailChecker,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const words = [checker.node, checker.script, ...args].map((word) => quote(word, platform));
  return platform === 'win32'
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${words.join(' ')}`
    : `ELECTRON_RUN_AS_NODE=1 exec ${words.join(' ')}`;
}

/** 规则种类 → 要挂的事件。 */
const EVENT_OF_KIND: Readonly<Record<string, 'PreToolUse' | 'Stop'>> = {
  forbidden_command: 'PreToolUse',
  protected_path: 'PreToolUse',
  commit_check: 'PreToolUse',
  stop_check: 'Stop',
};

/** PreToolUse 只看这两种工具：执行命令（Codex 报成 `Bash`）与改文件。 */
export const GUARDRAIL_TOOL_MATCHER = 'Bash|apply_patch';

/** 检查程序自己的开销之外留的余量（秒）。 */
const HOOK_TIMEOUT_SLACK_SEC = 30;

/** 护栏的规则里与挂 hook 有关的部分。 */
export interface GuardrailHookRule {
  kind: string;
  timeoutSec?: number;
}

/**
 * 一个会话要挂的检查程序 hooks：有哪种规则（开着关着都算，开关随时生效）就挂对应的事件。时限是这一事件里会跑的检查命令的时限之和
 * 加余量（结束前检查依次跑）。
 */
export function guardrailHooks(
  checker: GuardrailChecker,
  workspaceId: string | undefined,
  rules: readonly GuardrailHookRule[],
  platform: NodeJS.Platform = process.platform,
): EngineHook[] {
  const args = [
    '--dir',
    checker.dir,
    ...(workspaceId === undefined ? [] : ['--workspace', workspaceId]),
  ];
  const command = guardrailCheckerCommand(checker, args, platform);
  const hooks: EngineHook[] = [];
  for (const event of ['PreToolUse', 'Stop'] as const) {
    const matching = rules.filter((rule) => EVENT_OF_KIND[rule.kind] === event);
    if (matching.length === 0) continue;
    const checks = matching
      .filter((rule) => rule.kind === 'stop_check' || rule.kind === 'commit_check')
      .reduce((sum, rule) => sum + (rule.timeoutSec ?? 600), 0);
    hooks.push({
      event,
      ...(event === 'PreToolUse' && { matcher: GUARDRAIL_TOOL_MATCHER }),
      command,
      timeoutSec: checks + HOOK_TIMEOUT_SLACK_SEC,
    });
  }
  return hooks;
}

/** 用户启用的仓库 hook 经检查程序转一手（`--exec`，命令按 base64 传，免得再套一层引号）。 */
export function repoHookCommand(
  checker: GuardrailChecker,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return guardrailCheckerCommand(
    checker,
    ['--exec', Buffer.from(command, 'utf8').toString('base64')],
    platform,
  );
}
