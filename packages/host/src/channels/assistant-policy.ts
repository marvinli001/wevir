// 助理的规矩由 Host 执行（0.132.0，ADR-0020）：助理的会话（协调者、线程，以及它们派出的子会话与开的会话）照常用 `on_request`
// 跑，引擎要批准的每个工具调用先经这里归类，再按助理的规矩替用户答：
// - 归不进任何一类（读写工作区与授权文件夹、跑命令、联网、内置浏览器、Wevir 自己的工具）：直接允许，不问；
// - 归进一类：按那一类的档位，`do` / `tell` 允许，`ask` 照常发审批（收件箱与手机推送），`hand_off` 拒绝（只准备内容，交给用户做）；
// - 转账、交易、证券：任何档都拒绝。
// 改文件的路径不全在工作区与授权文件夹里时照常问。`tell` 的告知不靠审批：频道看着会话的 `tool.started` / `tool.finished`，回合
// 结束时把做完的写成一条 `notice: acted`。
//
// 只能看到引擎拿来要批准的调用：引擎不问就做的（Codex 沙箱里的命令与改文件、内置浏览器里点的按钮）这里管不到，靠提示词里的规矩。
// 归类按工具名与命令里的词猜，宁可多问也不错放。

import { isAbsolute, resolve, sep } from 'node:path';
import type {
  AssistantRuleCategory,
  AssistantRules,
  AssistantRuleTier,
  ToolDisplay,
} from '@wevir/protocol';
import { DEFAULT_ASSISTANT_RULES } from '@wevir/protocol';
import {
  basename,
  RUNS_OTHER_PROGRAMS,
  splitShellCommand,
} from '../approval-rules/command-prefix.js';

export interface PolicyTool {
  toolName: string;
  display: ToolDisplay;
  input?: unknown;
}

/** 一个工具调用归成什么：硬禁止、某一类动作、改工作区外的文件，或普通的调用。 */
export type AssistantAction =
  | { kind: 'forbidden' }
  | { kind: 'category'; category: AssistantRuleCategory }
  | { kind: 'outside' }
  | { kind: 'routine' };

/** Host 替用户怎么答：允许、照常问、拒绝（`notice` 是写进时间线的说明）。 */
export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'ask' }
  | { decision: 'reject'; notice: 'handed_off' | 'blocked'; category?: AssistantRuleCategory };

/** 工作区根目录与授权的文件夹（都是 realpath）。 */
export interface PolicyRoots {
  root: string;
  folders: readonly string[];
}

/** 某一类在这个助理的规矩里是哪一档；没写的用新助理的默认档。 */
export function tierOf(rules: AssistantRules, category: AssistantRuleCategory): AssistantRuleTier {
  return rules[category] ?? DEFAULT_ASSISTANT_RULES[category];
}

export function decide(action: AssistantAction, rules: AssistantRules): PolicyDecision {
  switch (action.kind) {
    case 'routine':
      return { decision: 'allow' };
    case 'outside':
      return { decision: 'ask' };
    case 'forbidden':
      return { decision: 'reject', notice: 'blocked' };
    case 'category': {
      const tier = tierOf(rules, action.category);
      if (tier === 'ask') return { decision: 'ask' };
      if (tier === 'hand_off') {
        return { decision: 'reject', notice: 'handed_off', category: action.category };
      }
      return { decision: 'allow' };
    }
  }
}

// ── 归类 ──────────────────────────────────────────────────────────────

/** Wevir 自己的工具（频道、记忆、进程、浏览器、电脑操作…）：只作用于本机与助理自己，不归类。 */
const OWN_TOOL = /^(wevir_|browser_|computer_)/;
const OWN_SERVER = /^wevir/;

/** 只读的动词：有它、又没有下面会改东西的动词时是普通调用。 */
const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'find',
  'query',
  'lookup',
  'view',
  'show',
  'describe',
  'retrieve',
  'check',
  'count',
  'preview',
  'quote',
  'quotes',
  'price',
  'prices',
  'history',
  'status',
  'download',
  'summarize',
]);

const DELETE_VERBS = new Set([
  'delete',
  'remove',
  'trash',
  'destroy',
  'purge',
  'erase',
  'unlink',
  'rm',
  'drop',
  'wipe',
]);
const PURCHASE_WORDS = new Set(['buy', 'purchase', 'checkout', 'pay', 'payment', 'payments']);
const ORDER_VERBS = new Set(['place', 'create', 'submit', 'confirm']);
const MESSAGE_VERBS = new Set(['send', 'reply', 'forward', 'respond', 'dm', 'sms']);
const MESSAGE_NOUNS = new Set(['message', 'messages', 'chat', 'comment', 'reply', 'email', 'mail']);
const PUBLISH_WORDS = new Set([
  'publish',
  'tweet',
  'retweet',
  'toot',
  'deploy',
  'release',
  'post',
  'unpublish',
]);
const WRITE_VERBS = new Set([
  'create',
  'update',
  'edit',
  'insert',
  'append',
  'modify',
  'write',
  'move',
  'rename',
  'share',
  'invite',
  'add',
  'set',
  'patch',
  'upsert',
  'put',
  'schedule',
  'accept',
  'decline',
  'rsvp',
  'upload',
  'assign',
  'close',
  'merge',
]);

/** 会做事的动词（名词如 `payment`、`post`、`order` 不算）：工具名里有它就不是只读的。 */
const ACTION_VERBS = new Set([
  ...WRITE_VERBS,
  ...DELETE_VERBS,
  ...MESSAGE_VERBS,
  'publish',
  'tweet',
  'retweet',
  'toot',
  'deploy',
  'unpublish',
  'buy',
  'purchase',
  'checkout',
  'pay',
  'sell',
  'place',
  'short',
  'trade',
  'swap',
  'transfer',
  'withdraw',
  'payout',
  'remit',
  'wire',
]);

/** 交易：有这些词又有下单类的词。 */
const TRADE_ASSETS = new Set([
  'stock',
  'stocks',
  'share',
  'shares',
  'equity',
  'equities',
  'etf',
  'option',
  'options',
  'futures',
  'securities',
  'crypto',
  'coin',
  'coins',
  'bitcoin',
  'btc',
  'eth',
  'token',
  'tokens',
  'position',
  'positions',
  'forex',
]);
const TRADE_VERBS = new Set(['buy', 'sell', 'order', 'place', 'short', 'trade', 'trades', 'swap']);
/** 转账：单独出现就算。 */
const MONEY_MOVES = new Set([
  'withdraw',
  'withdrawal',
  'payout',
  'payouts',
  'remit',
  'remittance',
  'wire',
]);
const MONEY_NOUNS = new Set([
  'money',
  'fund',
  'funds',
  'balance',
  'bank',
  'wallet',
  'usd',
  'cash',
  'crypto',
  'coin',
  'coins',
  'token',
  'tokens',
  'payment',
]);
/** 券商与交易所的连接器：除了只读的调用一律硬禁止。 */
const BROKER_SERVERS =
  /(alpaca|robinhood|ibkr|interactive.?brokers|coinbase|binance|kraken|schwab|etrade|webull|futu|tiger|okx|bybit|trading212|tradier)/i;
/** 付款服务：转出钱的调用硬禁止，其余算购买。 */
const PAYMENT_SERVERS = /(stripe|paypal|wise|venmo|cash.?app|alipay|wechat.?pay|revolut|square)/i;

/** 工具名拆成小写的词：`mcp__gmail__send_email`、`sendEmail`、`calendar.events.insert` 都行。 */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/** `mcp__<server>__<tool>` 拆开；不是这个形状时服务取展示里的 `mcpServer`。 */
function serverAndTool(tool: PolicyTool): { server: string | undefined; name: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool.toolName);
  if (match !== null) return { server: match[1], name: match[2] as string };
  return { server: tool.display.mcpServer, name: tool.toolName };
}

function some(list: readonly string[], set: ReadonlySet<string>): boolean {
  return list.some((word) => set.has(word));
}

/** 连接器与其它工具：按工具名里的词归类。 */
function classifyNamed(server: string | undefined, name: string): AssistantAction {
  const tokens = words(name);
  const all = server === undefined ? tokens : [...words(server), ...tokens];
  const readOnly = some(tokens, READ_VERBS) && !some(tokens, ACTION_VERBS);
  if (readOnly) return { kind: 'routine' };
  // 硬禁止先看。
  if (server !== undefined && BROKER_SERVERS.test(server)) return { kind: 'forbidden' };
  if (some(tokens, MONEY_MOVES)) return { kind: 'forbidden' };
  if (tokens.includes('transfer') && some(all, MONEY_NOUNS)) return { kind: 'forbidden' };
  if (some(tokens, TRADE_VERBS) && some(all, TRADE_ASSETS)) return { kind: 'forbidden' };
  if (server !== undefined && PAYMENT_SERVERS.test(server)) {
    if (tokens.includes('transfer') || tokens.includes('send')) return { kind: 'forbidden' };
    return { kind: 'category', category: 'purchases' };
  }
  if (some(tokens, DELETE_VERBS)) return { kind: 'category', category: 'deletions' };
  if (some(tokens, PURCHASE_WORDS) || (tokens.includes('order') && some(tokens, ORDER_VERBS))) {
    return { kind: 'category', category: 'purchases' };
  }
  if (some(tokens, MESSAGE_VERBS)) return { kind: 'category', category: 'messages' };
  if (tokens.includes('post') && some(tokens, MESSAGE_NOUNS)) {
    return { kind: 'category', category: 'messages' };
  }
  if (some(tokens, PUBLISH_WORDS)) return { kind: 'category', category: 'publishing' };
  // 外部服务上会改东西的调用：改的是别人也看得到的文档、日历与记录。
  if (server !== undefined && some(tokens, WRITE_VERBS)) {
    return { kind: 'category', category: 'shared_edits' };
  }
  return { kind: 'routine' };
}

const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash']);
const MAIL_PROGRAMS = new Set(['mail', 'mailx', 'sendmail', 'mutt', 'msmtp', 'neomutt']);
const DEPLOY_PROGRAMS = new Set([
  'vercel',
  'netlify',
  'wrangler',
  'firebase',
  'fly',
  'flyctl',
  'surge',
]);
const PUBLISH_SUBCOMMANDS = new Set(['push', 'publish', 'deploy']);
const DELETE_SUBCOMMANDS = new Set(['delete', 'rm', 'rmi', 'destroy']);

/** 程序名之后、第一个选项或路径之前的几个词。 */
function subcommands(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (const token of argv.slice(1)) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(token)) break;
    result.push(token);
    if (result.length === 3) break;
  }
  return result;
}

function commandCategory(argv: readonly string[]): AssistantRuleCategory | undefined {
  const program = argv[0];
  if (program === undefined) return undefined;
  const name = basename(program);
  if (DELETE_PROGRAMS.has(name)) return 'deletions';
  if (name === 'find' && argv.includes('-delete')) return 'deletions';
  if (MAIL_PROGRAMS.has(name)) return 'messages';
  const sub = subcommands(argv);
  if (sub.some((word) => DELETE_SUBCOMMANDS.has(word))) return 'deletions';
  if (DEPLOY_PROGRAMS.has(name) || sub.some((word) => PUBLISH_SUBCOMMANDS.has(word))) {
    return 'publishing';
  }
  // 包一层再跑别的程序（`sudo rm`、`xargs rm`）：被包的程序按同样的办法看。
  if (RUNS_OTHER_PROGRAMS.has(name)) {
    const inner = argv.findIndex(
      (token, i) => i > 0 && !token.startsWith('-') && !/^\d/.test(token) && !token.includes('='),
    );
    if (inner > 0) return commandCategory(argv.slice(inner));
  }
  return undefined;
}

/** 拆不开的命令（重定向、展开…）大致按 `;`、`&`、`|` 与空白切开再看。 */
function roughCommands(command: string): string[][] {
  return command
    .split(/[;&|\n()`]+/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^['"]|['"]$/g, ''))
        .filter((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)),
    )
    .filter((argv) => argv.length > 0);
}

/** 命令里最该问的一类：删除先于发布先于发消息。 */
function classifyCommand(command: string): AssistantAction {
  const commands = splitShellCommand(command) ?? roughCommands(command);
  const found = new Set<AssistantRuleCategory>();
  for (const argv of commands) {
    const category = commandCategory(argv);
    if (category !== undefined) found.add(category);
  }
  for (const category of ['deletions', 'publishing', 'messages'] as const) {
    if (found.has(category)) return { kind: 'category', category };
  }
  return { kind: 'routine' };
}

function commandOf(tool: PolicyTool): string | undefined {
  const input = tool.input;
  if (input !== null && typeof input === 'object') {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
    if (Array.isArray(command) && command.every((t) => typeof t === 'string')) {
      return command.join(' ');
    }
  }
  return tool.display.command;
}

function inside(path: string, roots: PolicyRoots): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(roots.root, path);
  return [roots.root, ...roots.folders].some((folder) => {
    const root = resolve(folder);
    return absolute === root || absolute.startsWith(`${root}${sep}`);
  });
}

/** 一个要批准的工具调用归成什么。 */
export function classify(tool: PolicyTool, roots: PolicyRoots): AssistantAction {
  const { server, name } = serverAndTool(tool);
  if (OWN_TOOL.test(name) || (server !== undefined && OWN_SERVER.test(server))) {
    return { kind: 'routine' };
  }
  switch (tool.display.kind) {
    case 'shell': {
      const command = commandOf(tool);
      return command === undefined ? { kind: 'routine' } : classifyCommand(command);
    }
    case 'edit':
    case 'write': {
      if (server !== undefined) return classifyNamed(server, name);
      const paths = tool.display.paths ?? [];
      if (paths.length > 0 && !paths.every((path) => inside(path, roots))) {
        return { kind: 'outside' };
      }
      return { kind: 'category', category: 'local_files' };
    }
    case 'read':
    case 'search':
    case 'fetch':
    case 'plan':
    case 'sub_agent':
    case 'image':
      return server === undefined ? { kind: 'routine' } : classifyNamed(server, name);
    case 'unknown':
      return classifyNamed(server, name);
  }
}

/** 时间线上说这个调用的一行：展示的摘要，没有时是工具名。 */
export function actionSummary(tool: PolicyTool): string {
  const summary = tool.display.summary?.trim();
  return summary !== undefined && summary !== '' ? summary : tool.toolName;
}
