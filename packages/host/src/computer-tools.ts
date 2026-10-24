// 电脑操作（0.114.0，domain-model §3.15.8）的应用级工具 `computer_*`：经 `ComputerBroker` 交给桌面端，桌面端主进程的原生 helper
// 执行。设置的 `computerUse` 关着时 `filterTools` 不列它们，调用回 `computer_disabled`。
//
// 不走引擎的审批：用户在 `computer_request_access` 弹出的框里逐个应用批准，就是这组工具的批准（同 Claude 的电脑操作）；之后
// 每个动作由 helper 按应用的档位核对。所以动作工具标 `destructiveHint: false, openWorldHint: false`（Codex 据此不问），名字并进
// `APP_TOOLS_NO_APPROVAL`（Claude 与 OpenCode）。
//
// 第一次批准成功时，结果后面接上电脑操作的使用规则（prompts/plugins/computer-use/SKILL.md 渲染后的正文：选工具的顺序、链接、
// 金融操作与四档确认），每个会话在 Host 运行期间给一次。

import { readFileSync } from 'node:fs';
import { normalize, resolve, sep } from 'node:path';
import type { ComputerCommand, ComputerContent, SessionId } from '@wevir/protocol';
import {
  COMPUTER_ACCESS_TIMEOUT_MS,
  COMPUTER_BATCH_MAX,
  ComputerCommandSchema,
} from '@wevir/protocol';
import { type AppTool, AppToolError, type AppToolResult } from './app-mcp.js';
import { objectSchema } from './app-tools.js';
import type { ComputerBroker, ComputerPayload } from './computer-broker.js';

/** 不改变任何东西的电脑操作工具（标 `readOnlyHint`）。 */
export const COMPUTER_READ_ONLY_TOOLS = [
  'computer_list_apps',
  'computer_screenshot',
  'computer_zoom',
  'computer_ax_tree',
  'computer_ax_find',
] as const;

/** 全部电脑操作工具的名字（设置关着时 `filterTools` 去掉）。 */
export const COMPUTER_TOOLS = [
  'computer_request_access',
  ...COMPUTER_READ_ONLY_TOOLS,
  'computer_open_app',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_set_value',
  'computer_clipboard_read',
  'computer_clipboard_write',
  'computer_batch',
] as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** 动作：批准在授权框里做过了，不再走引擎的审批。 */
const ACTS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const APP = {
  type: 'string',
  description: 'App bundle ID (com.apple.Notes) or name as shown in computer_list_apps (Notes).',
};
const REF = {
  type: 'string',
  pattern: '^@a\\d+$',
  description:
    'Element ref like @a12 from the latest computer_ax_tree or computer_ax_find of that app.',
};
const X = {
  type: 'number',
  description: 'Pixel x in the latest screenshot (or zoom) of this session.',
};
const Y = {
  type: 'number',
  description: 'Pixel y in the latest screenshot (or zoom) of this session.',
};
const COORDS_NOTE =
  'Coordinates are pixels in the latest computer_screenshot or computer_zoom image of this session; take a new screenshot after the screen changes.';

interface ToolSpec {
  name: (typeof COMPUTER_TOOLS)[number];
  title: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  annotations: Record<string, boolean>;
  /** 参数换成命令（形状由协议的 schema 再校验一次）；组合不对时抛 `AppToolError`。 */
  command(args: Record<string, unknown>): unknown;
  timeoutMs?: number;
}

const ACTION_PROPERTIES: Record<string, Record<string, unknown>> = {
  action: {
    type: 'string',
    enum: [
      'click',
      'type',
      'key',
      'scroll',
      'drag',
      'set_value',
      'open_app',
      'screenshot',
      'zoom',
      'wait',
    ],
  },
  x: { type: 'number' },
  y: { type: 'number' },
  ref: { type: 'string' },
  button: { type: 'string', enum: ['left', 'right', 'middle'] },
  clickCount: { type: 'integer' },
  modifiers: { type: 'array', items: { type: 'string' } },
  text: { type: 'string' },
  keys: { type: 'string' },
  repeat: { type: 'integer' },
  dx: { type: 'integer' },
  dy: { type: 'integer' },
  fromX: { type: 'number' },
  fromY: { type: 'number' },
  toX: { type: 'number' },
  toY: { type: 'number' },
  value: { type: 'string' },
  app: { type: 'string' },
  windowId: { type: 'integer' },
  width: { type: 'number' },
  height: { type: 'number' },
  seconds: { type: 'number' },
};

function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  return out;
}

/** 坐标或元素恰好给一种。 */
function pointOrRef(args: Record<string, unknown>, tool: string): void {
  const hasPoint = args.x !== undefined || args.y !== undefined;
  const hasRef = args.ref !== undefined;
  if (hasPoint === hasRef) {
    throw new AppToolError(`${tool} needs either x and y, or ref (not both).`);
  }
  if (hasPoint && (typeof args.x !== 'number' || typeof args.y !== 'number')) {
    throw new AppToolError(`${tool} needs both x and y.`);
  }
}

const ACTION_KEYS: Record<string, readonly string[]> = {
  click: ['x', 'y', 'ref', 'button', 'clickCount', 'modifiers'],
  type: ['text', 'ref'],
  key: ['keys', 'repeat'],
  scroll: ['x', 'y', 'ref', 'dx', 'dy'],
  drag: ['fromX', 'fromY', 'toX', 'toY'],
  set_value: ['ref', 'value'],
  open_app: ['app'],
  screenshot: ['app', 'windowId'],
  zoom: ['x', 'y', 'width', 'height'],
  wait: ['seconds'],
};

function checkAction(command: string, args: Record<string, unknown>): void {
  if (command === 'click') pointOrRef(args, 'click');
  if (command === 'scroll') {
    pointOrRef(args, 'scroll');
    if (!args.dx && !args.dy) throw new AppToolError('scroll needs a non-zero dx or dy.');
  }
}

const SPECS: ToolSpec[] = [
  {
    name: 'computer_request_access',
    title: 'Request computer access',
    description:
      "Ask the user to let you operate desktop apps on their computer. Required before any other computer_* action on an app; Wevir shows a dialog and the user approves each app. Approval tiers come from the app's kind: browsers are read-only (screenshots only; use browser tools for web pages), terminals and IDEs allow left clicks and scrolling only (use your shell and file tools instead of typing there), every other app gets full control. Name every app you will need (Finder covers the desktop and the Dock). Wevir itself cannot be granted. The result lists what was approved; the first approval also includes the rules for computer use, which you must follow. Computer use is a last resort: prefer a dedicated tool, MCP server or CLI for the app, the browser tools for anything on the web, and your shell for anything a command can do. Never trade, pay or move money. The user can press Esc at any time to stop you; then stop and wait for them.",
    properties: {
      apps: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
        description: 'Apps by name (Notes, 备忘录) or bundle ID (com.apple.Notes).',
      },
      reason: {
        type: 'string',
        description: 'One sentence the user sees in the dialog: what you will do in these apps.',
      },
    },
    required: ['apps', 'reason'],
    annotations: ACTS,
    command: (args) => ({ command: 'request_access', args: pick(args, ['apps', 'reason']) }),
    timeoutMs: COMPUTER_ACCESS_TIMEOUT_MS,
  },
  {
    name: 'computer_list_apps',
    title: 'List apps and windows',
    description:
      'Running apps with their on-screen windows (windowId, title, position) and the access tier this session has for each. Use it to find a windowId for computer_screenshot.',
    properties: {},
    required: [],
    annotations: READ_ONLY,
    command: () => ({ command: 'list_apps', args: {} }),
  },
  {
    name: 'computer_open_app',
    title: 'Open app',
    description:
      'Open an approved app, or bring it to the front if it is running. Needed before typing or pressing keys into an app that is not in front (keys go to the frontmost app).',
    properties: { app: APP },
    required: ['app'],
    annotations: ACTS,
    command: (args) => ({ command: 'open_app', args: pick(args, ['app']) }),
  },
  {
    name: 'computer_screenshot',
    title: 'Screenshot',
    description: `Take a screenshot. With no arguments: the screen, showing only the windows of apps approved in this session (everything else, Wevir included, is left out). With app or windowId: just that window, even when it is covered or in the background; clicks and keys on that image are then sent to that window in the background where the app accepts it. ${COORDS_NOTE}`,
    properties: {
      app: { ...APP, description: `${APP.description} Captures its frontmost window.` },
      windowId: { type: 'integer', description: 'windowId from computer_list_apps.' },
      displayId: { type: 'integer', description: 'Display to capture (screen only).' },
    },
    required: [],
    annotations: READ_ONLY,
    command: (args) => ({
      command: 'screenshot',
      args: pick(args, ['app', 'windowId', 'displayId']),
    }),
  },
  {
    name: 'computer_zoom',
    title: 'Zoom into screenshot',
    description:
      'Capture a region of the latest screenshot again at full screen resolution, to read small text or check details. x, y, width and height are pixels in the latest screenshot; later coordinates refer to the zoomed image.',
    properties: {
      x: X,
      y: Y,
      width: { type: 'number' },
      height: { type: 'number' },
    },
    required: ['x', 'y', 'width', 'height'],
    annotations: READ_ONLY,
    command: (args) => ({ command: 'zoom', args: pick(args, ['x', 'y', 'width', 'height']) }),
  },
  {
    name: 'computer_ax_tree',
    title: 'Read accessibility tree',
    description:
      "Read an approved app's interface structure from macOS accessibility: windows, buttons, text fields, menus with titles, values and screen positions. Elements get refs like @a12 for computer_click, computer_type, computer_set_value and computer_scroll; acting by ref is more reliable than clicking pixels and works without bringing the app forward. Refs of an app expire when you read its tree again. Long trees are cut: pass windowId, or use computer_ax_find.",
    properties: {
      app: APP,
      windowId: { type: 'integer', description: 'Only this window (from computer_list_apps).' },
      maxNodes: { type: 'integer', description: 'Element limit, default 250.' },
    },
    required: ['app'],
    annotations: READ_ONLY,
    command: (args) => ({ command: 'ax_tree', args: pick(args, ['app', 'windowId', 'maxNodes']) }),
  },
  {
    name: 'computer_ax_find',
    title: 'Find elements',
    description:
      'Find elements of an approved app by text (in title, description, value or identifier) and/or role (button, textField, textArea, checkBox, menuItem…). Results get refs like computer_ax_tree; earlier refs stay valid.',
    properties: {
      app: APP,
      text: { type: 'string' },
      role: { type: 'string' },
      windowId: { type: 'integer' },
      maxResults: { type: 'integer', description: 'Default 20.' },
    },
    required: ['app'],
    annotations: READ_ONLY,
    command: (args) => {
      if (args.text === undefined && args.role === undefined) {
        throw new AppToolError('computer_ax_find needs text, role or both.');
      }
      return {
        command: 'ax_find',
        args: pick(args, ['app', 'text', 'role', 'windowId', 'maxResults']),
      };
    },
  },
  {
    name: 'computer_click',
    title: 'Click',
    description: `Click at x, y or on an element ref. A plain left click on a ref presses it through accessibility without moving the mouse. Checked against the app under the point: it must be approved, terminals and IDEs allow plain left clicks only, browsers none. Never click web links in native apps; open them with the browser tools after checking the address. ${COORDS_NOTE}`,
    properties: {
      x: X,
      y: Y,
      ref: REF,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'integer', description: '2 for a double click.' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl', 'fn'] },
      },
    },
    required: [],
    annotations: ACTS,
    command: (args) => {
      checkAction('click', args);
      return { command: 'click', args: pick(args, ACTION_KEYS.click ?? []) };
    },
  },
  {
    name: 'computer_type',
    title: 'Type text',
    description:
      'Type text into the frontmost app (or the window of the latest window screenshot), or into an element ref. Newlines press Return. Needs full access to that app. Do not type passwords, payment details or verification codes for the user.',
    properties: { text: { type: 'string' }, ref: REF },
    required: ['text'],
    annotations: ACTS,
    command: (args) => ({ command: 'type', args: pick(args, ACTION_KEYS.type ?? []) }),
  },
  {
    name: 'computer_key',
    title: 'Press keys',
    description:
      'Press a key or shortcut in the frontmost app (or the window of the latest window screenshot): cmd+s, cmd+shift+t, Return, Escape, Tab, Down, PageDown, F5… Needs full access to that app.',
    properties: {
      keys: { type: 'string', description: 'Modifiers joined with +, then one key.' },
      repeat: { type: 'integer', description: 'Times to press, default 1.' },
    },
    required: ['keys'],
    annotations: ACTS,
    command: (args) => ({ command: 'key', args: pick(args, ACTION_KEYS.key ?? []) }),
  },
  {
    name: 'computer_scroll',
    title: 'Scroll',
    description: `Scroll at x, y or over an element ref by dx / dy lines (dy positive scrolls down). ${COORDS_NOTE}`,
    properties: { x: X, y: Y, ref: REF, dx: { type: 'integer' }, dy: { type: 'integer' } },
    required: [],
    annotations: ACTS,
    command: (args) => {
      checkAction('scroll', args);
      return { command: 'scroll', args: pick(args, ACTION_KEYS.scroll ?? []) };
    },
  },
  {
    name: 'computer_drag',
    title: 'Drag',
    description: `Drag with the left button from (fromX, fromY) to (toX, toY). Both apps must have full access. ${COORDS_NOTE}`,
    properties: {
      fromX: { type: 'number' },
      fromY: { type: 'number' },
      toX: { type: 'number' },
      toY: { type: 'number' },
    },
    required: ['fromX', 'fromY', 'toX', 'toY'],
    annotations: ACTS,
    command: (args) => ({ command: 'drag', args: pick(args, ACTION_KEYS.drag ?? []) }),
  },
  {
    name: 'computer_set_value',
    title: 'Set value',
    description:
      'Set the value of an element ref directly through accessibility (text fields, checkboxes, sliders), without moving the mouse or bringing the app forward.',
    properties: { ref: REF, value: { type: 'string' } },
    required: ['ref', 'value'],
    annotations: ACTS,
    command: (args) => ({ command: 'set_value', args: pick(args, ACTION_KEYS.set_value ?? []) }),
  },
  {
    name: 'computer_clipboard_read',
    title: 'Read clipboard',
    description:
      'Read the text on the clipboard (after you copied something in an approved app). Needs at least one approved app in this session.',
    properties: {},
    required: [],
    annotations: ACTS,
    command: () => ({ command: 'clipboard_read', args: {} }),
  },
  {
    name: 'computer_clipboard_write',
    title: 'Write clipboard',
    description:
      'Put text on the clipboard, for example to paste a long text with cmd+v. This replaces what the user copied. Needs at least one approved app in this session.',
    properties: { text: { type: 'string' } },
    required: ['text'],
    annotations: ACTS,
    command: (args) => ({ command: 'clipboard_write', args: pick(args, ['text']) }),
  },
  {
    name: 'computer_batch',
    title: 'Run computer actions in order',
    description: `Run up to ${COMPUTER_BATCH_MAX} actions in order and stop at the first error, to save round trips when you know the next steps (click a field, type, press Return, take a screenshot). Each action is { action, ...the arguments of that tool }: click, type, key, scroll, drag, set_value, open_app, screenshot, zoom, or wait { seconds } (at most 10). The result reports every step; screenshots taken in the batch are returned. ${COORDS_NOTE} A screenshot or zoom inside the batch changes what later coordinates refer to.`,
    properties: {
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: COMPUTER_BATCH_MAX,
        items: { type: 'object', properties: ACTION_PROPERTIES, required: ['action'] },
      },
    },
    required: ['actions'],
    annotations: ACTS,
    command: (args) => {
      const actions = args.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        throw new AppToolError('actions must be a non-empty array.');
      }
      return {
        command: 'batch',
        args: {
          actions: actions.map((raw, index) => {
            const action = (raw ?? {}) as Record<string, unknown>;
            const name = typeof action.action === 'string' ? action.action : '';
            const keys = ACTION_KEYS[name];
            if (keys === undefined) {
              throw new AppToolError(
                `actions[${index}].action must be one of ${Object.keys(ACTION_KEYS).join(', ')}.`,
              );
            }
            try {
              checkAction(name, action);
            } catch (error) {
              throw new AppToolError(`actions[${index}]: ${(error as Error).message}`);
            }
            return { command: name, args: pick(action, keys) };
          }),
        },
      };
    },
  },
];

export interface ComputerToolsOptions {
  broker: ComputerBroker;
  /** Host 设置的 `computerUse`；关着时调用回 `computer_disabled`（`filterTools` 也不列）。 */
  enabled: () => boolean;
  /** 第一次批准后交给 agent 的使用规则（渲染好的 SKILL.md）；没有时不给。 */
  guide?: string;
}

/** `computer_*` 工具。 */
export function computerTools(options: ComputerToolsOptions): AppTool[] {
  /** 这次 Host 运行里已经拿到使用规则的会话。 */
  const guided = new Set<SessionId>();
  return SPECS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: objectSchema(spec.properties, spec.required),
    annotations: spec.annotations,
    call: async (args, { sessionId, signal }) => {
      if (!options.enabled()) {
        return errorResult({
          ok: false,
          error: {
            code: 'computer_disabled',
            message:
              'Computer use is turned off. The user can turn it on in Wevir Settings > Computer use.',
          },
        });
      }
      let command: ComputerCommand;
      try {
        const parsed = ComputerCommandSchema.safeParse(spec.command(args));
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue?.path.filter((part) => part !== 'args').join('.') ?? '';
          throw new AppToolError(
            `Invalid arguments${where === '' ? '' : ` (${where})`}: ${issue?.message ?? 'see the tool schema'}.`,
          );
        }
        command = parsed.data;
      } catch (error) {
        if (error instanceof AppToolError) {
          return errorResult({
            ok: false,
            error: { code: 'computer_invalid_argument', message: error.message },
          });
        }
        throw error;
      }
      const payload = await options.broker.execute({
        sessionId,
        command,
        signal,
        ...(spec.timeoutMs !== undefined && { timeoutMs: spec.timeoutMs }),
      });
      if (!payload.ok) return errorResult(payload);
      const content: ComputerContent[] = [...payload.result.content];
      if (
        command.command === 'request_access' &&
        options.guide !== undefined &&
        !guided.has(sessionId) &&
        approvedSomething(content)
      ) {
        guided.add(sessionId);
        content.push({ type: 'text', text: options.guide });
      }
      return { content };
    },
  }));
}

/** 提供方在批准了至少一个应用时，结果的第一行以 “Approved” 开头。 */
function approvedSomething(content: readonly ComputerContent[]): boolean {
  const first = content[0];
  return first?.type === 'text' && first.text.startsWith('Approved');
}

function errorResult(payload: Extract<ComputerPayload, { ok: false }>): AppToolResult {
  return {
    content: [
      { type: 'text', text: `${payload.error.code}: ${payload.error.message}` },
      ...(payload.content ?? []),
    ],
    isError: true,
  };
}

const COMMENT = /<!--[\s\S]*?-->/g;
const INCLUDE = /\{\{>\s*([^\s}]+)\s*\}\}/g;

/**
 * 读电脑操作的使用规则：`prompts/plugins/computer-use/SKILL.md` 按 prompts/README.md 的模板语法渲染（删注释、展开 `{{> 路径 }}`），
 * 去掉开头的 YAML 头。读不到或残留 `{{` 时抛错。
 */
export function loadComputerGuide(promptsDir: string): string {
  const root = resolve(promptsDir);
  const read = (path: string, depth: number): string => {
    if (depth > 4) throw new Error('prompts include too deep');
    const full = resolve(root, normalize(path));
    if (!full.startsWith(root + sep)) throw new Error(`prompt include outside prompts/: ${path}`);
    return readFileSync(full, 'utf8')
      .replace(COMMENT, '')
      .replace(INCLUDE, (_, inner: string) => read(inner, depth + 1));
  };
  const text = read('plugins/computer-use/SKILL.md', 0)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .trim();
  if (text.includes('{{')) throw new Error('the computer use guide has a leftover {{');
  return text;
}
