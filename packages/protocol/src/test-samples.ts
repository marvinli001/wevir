// 仅供测试：各 schema 的合法与非法样例。不从 index.ts 导出，不进入构建产物。
// 合法样例以 TS 类型约束（与 z.infer 一致），非法样例各自只破坏一处，便于定位。

import type { Automation, AutomationRun } from './automations.js';
import type { BrowserTabInfo } from './browser.js';
import type { ClientIdentity } from './common.js';
import type {
  AccountState,
  ApprovalRequest,
  ApprovalResolution,
  BoardTask,
  Environment,
  MemoryNote,
  MemorySource,
  MemorySummary,
  PendingMessage,
  PromptSuggestion,
  ProviderProfile,
  QuestionRequest,
  Session,
  SessionGoal,
  SessionRules,
  SessionSnapshot,
  SubagentSummary,
  SuggestedTask,
  ToolDisplay,
  UserImagePart,
  Workspace,
} from './entities.js';
import type { ErrorData, ErrorDataSchemas } from './errors.js';
import type { WevirEventOf, WevirEventPayload, WevirEventType } from './events.js';
import type { GitStatusResult } from './git.js';
import {
  IMAGE_UPLOAD_DATA_MAX_LENGTH,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
} from './methods.js';
import type { HostProcess } from './processes.js';
import type { ReviewComment } from './review.js';
import type { Terminal } from './terminals.js';
import type {
  CheckDefinition,
  RepairChain,
  SessionAcceptance,
  VerificationRun,
} from './verification.js';

export const ULID = '01JA2B3C4D5E6F7G8H9JKMNPQR';
export const TS = '2026-10-12T08:00:00.000Z';
export const TS2 = '2026-10-12T08:00:05.250Z';

export const ids = {
  workspace: `ws_${ULID}`,
  /** 环境（0.15.0）。 */
  environment: `env_${ULID}`,
  session: `ses_${ULID}`,
  /** 子会话（0.6.0）。 */
  childSession: 'ses_01JA2B3C4D5E6F7G8H9JKMNPR1',
  childTurn: 'trn_01JA2B3C4D5E6F7G8H9JKMNPR1',
  childApproval: 'apr_01JA2B3C4D5E6F7G8H9JKMNPR1',
  turn: `trn_${ULID}`,
  approval: `apr_${ULID}`,
  stream: `stm_${ULID}`,
  subscription: `sub_${ULID}`,
  host: `hst_${ULID}`,
  /** 待发消息（R11）。 */
  pending: `pnd_${ULID}`,
  pending2: 'pnd_01JA2B3C4D5E6F7G8H9JKMNPR1',
  /** 提问（0.10.0）。 */
  question: `qst_${ULID}`,
  /** 建议的后续任务（0.16.0）。 */
  task: `tsk_${ULID}`,
  task2: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPR1',
  /** 消息里的图片（0.28.0）。 */
  image: `img_${ULID}`,
  /** 浏览器请求（0.33.0）。 */
  browserRequest: `brq_${ULID}`,
  /** 回合后验证（0.65.0）。 */
  check: `chk_${ULID}`,
  check2: 'chk_01JA2B3C4D5E6F7G8H9JKMNPR2',
  verificationRun: `vrn_${ULID}`,
  verificationRound: `vrd_${ULID}`,
  repair: `rpr_${ULID}`,
  /** 自动化与它的运行（0.66.0）。 */
  automation: `aut_${ULID}`,
  automationRun: `arn_${ULID}`,
  /** 行级批注（0.67.0）。 */
  reviewComment: `rvc_${ULID}`,
  reviewComment2: 'rvc_01JA2B3C4D5E6F7G8H9JKMNPR1',
} as const;

const SHA1 = '4f1c2e9a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e';
const SHA2 = '9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';

/** 一条行级批注（0.67.0）：新的一侧，原文挪了位置。 */
export const reviewComment: ReviewComment = {
  id: ids.reviewComment,
  workspaceId: ids.workspace,
  sessionId: ids.session,
  path: 'src/convert.ts',
  side: 'new',
  startLine: 12,
  endLine: 14,
  source: { kind: 'uncommitted' },
  base: SHA1,
  branch: 'main',
  snippet: 'export function toFahrenheit(c: number) {\n  return c * 9 / 5 + 32;\n}',
  body: '负数要四舍五入',
  status: 'pending',
  anchor: { state: 'relocated', startLine: 20, endLine: 22 },
  createdAt: TS,
  updatedAt: TS,
};

/** 已发送、过期的批注（0.67.0）：旧的一侧，回合快照上写的。 */
export const sentReviewComment: ReviewComment = {
  ...reviewComment,
  id: ids.reviewComment2,
  side: 'old',
  source: { kind: 'turn', turnId: ids.turn },
  head: SHA2,
  status: 'sent',
  sent: { sessionId: ids.session, at: TS2, turnId: ids.turn },
  anchor: { state: 'outdated', reason: 'changed' },
  updatedAt: TS2,
};

const INDEX_TOKEN = '3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a';
const GIT_TREE = '7c1e9a0b2d3f4e5a6b7c8d9e0f1a2b3c4d5e6f7a';

/** 一个仓库的暂存状态（0.67.0）：一个经 Wevir 暂存的文件、一个之前就暂存的、一个未跟踪的。 */
export const gitStatusSample: GitStatusResult = {
  repo: true,
  head: SHA1,
  branch: 'main',
  index: INDEX_TOKEN,
  files: [
    {
      path: 'src/convert.ts',
      staged: { status: 'modified', added: 3, removed: 1, by: 'wevir' },
      unstaged: { status: 'modified', added: 1, removed: 0 },
    },
    { path: 'docs/notes.md', staged: { status: 'added', added: 4, removed: 0, by: 'external' } },
    { path: 'scratch.txt', unstaged: { status: 'untracked' } },
  ],
  fileCount: 3,
  stagedTree: GIT_TREE,
  codeState: { kind: 'git', head: SHA1, tree: SHA2 },
  verification: {
    checks: [
      {
        checkId: ids.check,
        name: 'Unit tests',
        status: 'passed',
        runId: ids.verificationRun,
        finishedAt: TS2,
      },
      { checkId: ids.check2, name: 'Typecheck', status: 'not_run' },
    ],
    stagedMatchesWorkingTree: false,
  },
};

/** 还没有提交、正在合并的仓库（0.67.0）。 */
export const gitStatusUnborn: GitStatusResult = {
  repo: true,
  head: null,
  index: INDEX_TOKEN,
  files: [{ path: 'a.ts', unstaged: { status: 'modified' }, conflicted: true }],
  fileCount: 1,
  truncated: true,
  operation: 'merge',
  codeState: { kind: 'none', reason: 'unavailable' },
};

/** 一项检查（0.65.0）。 */
export const checkDefinition: CheckDefinition = {
  id: ids.check,
  name: 'test',
  command: 'pnpm test',
  cwd: '',
  timeoutMs: 600_000,
  kind: 'test',
  trigger: 'after_turn',
  paths: ['src/', 'test/**/*.ts'],
  source: {
    kind: 'package_script',
    file: 'package.json',
    script: 'test',
    scriptHash: 'sha256:ab12',
  },
  revision: 2,
  approvedAt: TS,
  createdAt: TS,
  updatedAt: TS2,
};

/** 一条验证记录（0.65.0）：测试失败。 */
export const verificationRun: VerificationRun = {
  id: ids.verificationRun,
  roundId: ids.verificationRound,
  checkId: ids.check,
  checkRevision: 2,
  name: 'test',
  command: 'pnpm test',
  cwd: '',
  kind: 'test',
  trigger: 'after_turn',
  turnId: ids.turn,
  status: 'failed',
  reason: 'exit_code',
  codeState: { kind: 'git', head: '4f1c2e9a', tree: '9d8e7f6a' },
  queuedAt: TS,
  startedAt: TS,
  finishedAt: TS2,
  durationMs: 5250,
  exitCode: 1,
  tests: { passed: 3, failed: 1, skipped: 0 },
  summary: 'not ok 4 - converts -40\n# pass 3\n# fail 1',
  output: { bytes: 1840, truncated: false },
  fingerprint: 'sha256:77aa',
};

/** Agent 起的后台进程（0.69.0）：还在跑。 */
export const agentProcess: HostProcess = {
  id: 'p3',
  workspaceId: ids.workspace,
  source: { kind: 'agent', sessionId: ids.session, turnId: ids.turn },
  name: 'dev server',
  command: 'pnpm dev',
  cwd: '/home/u/projects/demo',
  pid: 4242,
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: TS,
  bytes: 18_204,
  stopSignals: ['SIGINT', 'SIGTERM', 'SIGKILL'],
};

/** 检查的进程（0.69.0）：用户取消后退出。 */
export const checkProcess: HostProcess = {
  id: 'v1',
  workspaceId: ids.workspace,
  source: {
    kind: 'check',
    sessionId: ids.session,
    turnId: ids.turn,
    runId: ids.verificationRun,
    checkId: ids.check,
    trigger: 'after_turn',
  },
  name: 'test',
  command: 'pnpm test',
  cwd: '/home/u/projects/demo',
  pid: 4250,
  status: 'exited',
  exitCode: null,
  signal: 'SIGTERM',
  startedAt: TS,
  endedAt: TS2,
  bytes: 1840,
  stoppedBy: 'user',
  stopSignals: [],
};

/** 用户的交互终端（0.69.0）：在跑，前台是 vim。 */
export const terminalSample: Terminal = {
  id: `trm_${ULID}`,
  workspaceId: ids.workspace,
  sessionId: ids.session,
  cwd: '/home/u/projects/demo',
  shell: '/bin/zsh',
  pid: 4300,
  title: 'vim README.md',
  foreground: 'vim',
  cols: 120,
  rows: 32,
  status: 'running',
  exitCode: null,
  signal: null,
  createdAt: TS,
  clients: 1,
};

/** 用户的交互终端（0.69.0）：shell 自己退出了，还没关。 */
export const exitedTerminal: Terminal = {
  id: `trm_${ULID}`,
  workspaceId: ids.workspace,
  cwd: '/home/u/projects/demo',
  shell: '/bin/zsh',
  pid: 4301,
  title: '',
  cols: 80,
  rows: 24,
  status: 'exited',
  exitCode: 0,
  signal: null,
  createdAt: TS,
  endedAt: TS2,
  clients: 0,
};

/** 验收状态（0.65.0）。 */
export const acceptance: SessionAcceptance = {
  status: 'failed',
  roundId: ids.verificationRound,
  turnId: ids.turn,
  codeState: { kind: 'git', head: '4f1c2e9a', tree: '9d8e7f6a' },
  updatedAt: TS2,
};

/** 修复链（0.65.0）。 */
export const repairChain: RepairChain = {
  id: ids.repair,
  roundId: ids.verificationRound,
  originTurnId: ids.turn,
  status: 'stopped',
  attempt: 2,
  maxAttempts: 2,
  turnIds: [ids.childTurn],
  lastRoundId: ids.verificationRound,
  stopReason: 'limit',
  startedAt: TS,
  updatedAt: TS2,
};

/** 浏览器的一个标签页（0.33.0）。 */
export const browserTab: BrowserTabInfo = {
  browserId: 'tab_m2k1_1',
  url: 'http://localhost:5173/',
  title: 'Vite App',
  isActive: true,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  controller: 'agent',
};

/** 消息里的一张图片（0.28.0）。 */
export const imagePart: UserImagePart = {
  type: 'image',
  imageId: ids.image,
  mimeType: 'image/png',
  size: 48213,
  width: 1280,
  height: 800,
  name: 'screenshot.png',
};

export const identity: ClientIdentity = {
  deviceId: 'dev-6f1c2a',
  clientId: 'cli-3e9b70',
  clientKind: 'cli',
};

export const workspace: Workspace = {
  id: ids.workspace,
  rootPath: '/Users/me/projects/wevir',
  displayName: 'wevir',
  createdAt: TS,
  updatedAt: TS,
};

/** Host 的“对话”工作区（0.39.0）。 */
export const chatsWorkspace: Workspace = {
  id: ids.workspace,
  rootPath: '/Users/me/Library/Application Support/Wevir/chats',
  displayName: 'Chats',
  kind: 'chats',
  createdAt: TS,
  updatedAt: TS,
};

/** 环境（0.15.0）。 */
export const environment: Environment = {
  id: ids.environment,
  name: '前后端一起改',
  location: { kind: 'local' },
  folders: [
    { workspaceId: ids.workspace, worktree: 'new' },
    { workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPR2', worktree: 'none' },
  ],
  createdAt: TS,
  updatedAt: TS,
};

/** 建议的后续任务（0.16.0）。 */
export const suggestedTask: SuggestedTask = {
  id: ids.task,
  title: '补齐导出接口的测试',
  prompt: '给 src/export.ts 的三个导出函数补单元测试，跑通 pnpm test。',
  reason: '这次改了导出格式，还没有测试覆盖',
  toolCallId: 'call_suggest_1',
  turnId: ids.turn,
  status: 'suggested',
};

/** 共享任务清单里的任务（0.52.0）：一项在做、带备注，一项等它做完。 */
export const boardTask: BoardTask = {
  id: 't1',
  subject: '补齐导出接口的测试',
  description: '给 src/export.ts 的三个导出函数补单元测试，跑通 pnpm test。',
  status: 'in_progress',
  owner: ids.childSession,
  blockedBy: [],
  notes: [{ sessionId: ids.childSession, text: '两个函数已覆盖', at: TS2 }],
  createdBy: ids.session,
  createdAt: TS,
  updatedAt: TS2,
};

export const waitingBoardTask: BoardTask = {
  id: 't2',
  subject: '汇总测试结果',
  status: 'pending',
  blockedBy: ['t1'],
  notes: [],
  createdBy: ids.session,
  createdAt: TS,
  updatedAt: TS,
};

/** 输入建议（0.53.0）：刚结束的回合预测出的一句话。 */
export const promptSuggestion: PromptSuggestion = { turnId: ids.turn, text: '跑一下测试' };

export const reportedTask: SuggestedTask = {
  ...suggestedTask,
  id: ids.task2,
  status: 'reported',
  sessionId: ids.childSession,
  outcome: 'completed',
};

export const deepseekProvider: ProviderProfile = {
  id: 'deepseek-official',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [],
  defaultModelId: 'deepseek-chat',
  hasSecret: true,
  createdAt: TS,
  updatedAt: TS,
};

export const compatibleProvider: ProviderProfile = {
  id: 'local-ollama',
  kind: 'openai-compatible',
  displayName: '本机 Ollama',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:11434/v1',
  compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  models: [
    { id: 'qwen3:8b', displayName: 'Qwen3 8B', contextWindow: 32768 },
    {
      id: 'qwen3-vl:8b',
      contextWindow: 262144,
      maxTokens: 32768,
      supportsImages: true,
      reasoningEfforts: ['off', 'high'],
    },
  ],
  defaultModelId: 'qwen3:8b',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};

/** ChatGPT 订阅（0.7.0）：没有 Key、地址与 compat，模型来自引擎。 */
export const chatgptProvider: ProviderProfile = {
  id: 'chatgpt',
  kind: 'chatgpt',
  displayName: 'ChatGPT',
  models: [
    {
      id: 'gpt-6.1-sol',
      displayName: 'GPT-6.1-Sol',
      supportsImages: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ],
  defaultModelId: 'gpt-6.1-sol',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};

/** 订阅来源（0.19.0）：Claude Agent，模型来自引擎，已停用。 */
export const claudeProvider: ProviderProfile = {
  id: 'claude',
  kind: 'claude',
  displayName: 'Claude Agent',
  models: [
    { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', reasoningEfforts: ['low', 'high'] },
  ],
  defaultModelId: 'claude-opus-5-5',
  hasSecret: false,
  enabled: false,
  createdAt: TS,
  updatedAt: TS,
};

/** 订阅来源（0.19.0）：用户在终端里登录的 Claude Agent。 */
export const claudeAccount: AccountState = {
  kind: 'claude',
  status: 'signed_in',
  email: 'me@example.com',
  plan: 'max',
  planLabel: 'Max 20x',
  signIn: 'command',
  loginCommand: 'claude auth login',
  installed: true,
  version: '2.1.140',
  executablePath: '/Users/me/.local/bin/claude',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
};

/** 订阅来源（0.19.0）：Wevir 正在替用户下载 Antigravity。 */
/** WorkBuddy（0.55.0）：用户自己安装并登录 codebuddy。 */
export const workbuddyAccount: AccountState = {
  kind: 'workbuddy',
  status: 'signed_in',
  signIn: 'command',
  loginCommand: 'codebuddy',
  installed: true,
  version: '2.168.2',
};
export const workbuddyProvider: ProviderProfile = {
  id: 'workbuddy',
  kind: 'workbuddy',
  displayName: 'WorkBuddy',
  models: [{ id: 'workbuddy-auto', displayName: 'Auto' }],
  defaultModelId: 'workbuddy-auto',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};

/** 0.56.0：WorkBuddy 未登录，应用内有国内 / 国际两种登录方式可选。 */
export const workbuddyLoginAccount: AccountState = {
  kind: 'workbuddy',
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['browser'],
  loginOptions: [
    { id: 'internal', label: 'WeChat' },
    { id: 'external', label: 'Google / GitHub' },
  ],
  installed: true,
  version: '2.168.2',
};

export const antigravityInstalling: AccountState = {
  kind: 'antigravity',
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['browser'],
  installed: false,
  canInstall: true,
  installing: { completedBytes: 1048576, totalBytes: 293601280 },
};

export const signedInAccount: AccountState = {
  kind: 'chatgpt',
  status: 'signed_in',
  email: 'me@example.com',
  plan: 'plus',
  rateLimits: {
    primary: { usedPercent: 23, windowMinutes: 300, resetsAt: TS2 },
    secondary: { usedPercent: 40.5, windowMinutes: 10080 },
  },
};

/** 0.45.0：三个以上的窗口、按月的窗口与额度的名字（OpenCode Go、Cursor 的用量）。 */
export const multiWindowAccount: AccountState = {
  kind: 'cursor',
  status: 'signed_in',
  email: 'me@example.com',
  signIn: 'in_app',
  loginMethods: ['browser'],
  rateLimits: {
    primary: { usedPercent: 12, period: 'monthly', resetsAt: TS2 },
    secondary: { usedPercent: 4, period: 'monthly', resetsAt: TS2, scope: 'Auto + Composer' },
    windows: [
      { usedPercent: 12, period: 'monthly', resetsAt: TS2 },
      { usedPercent: 4, period: 'monthly', resetsAt: TS2, scope: 'Auto + Composer' },
      { usedPercent: 37.5, period: 'monthly', resetsAt: TS2, scope: 'API' },
    ],
  },
};

/** 0.56.0：OpenCode 装好就已登录（Zen 的免登录模型），再接一家上游时是 signing_in，设备码在 login 里。 */
export const connectingUpstreamAccount: AccountState = {
  kind: 'opencode',
  status: 'signing_in',
  plan: 'opencode',
  planLabel: 'OpenCode',
  signIn: 'in_app',
  loginMethods: ['browser', 'device_code'],
  installed: true,
  version: '1.19.3',
  login: {
    loginId: '9d1f64f2-3a0b-4e0e-8a53-b8f1f1a6d3c1',
    method: 'device_code',
    verificationUrl: 'https://github.com/login/device',
    userCode: 'FE5D-F5E4',
    startedAt: TS,
  },
};

/** 0.63.0：添加的第二个 Claude 账号，带标签，凭据在 Wevir 的私有目录（不是本机终端的登录）。 */
export const labeledClaudeAccount: AccountState = {
  kind: 'claude',
  id: 'claude-3f9a',
  label: '工作',
  multiAccount: true,
  status: 'signed_in',
  email: 'work@example.com',
  plan: 'max',
  planLabel: 'Max 5x',
  signIn: 'in_app',
  loginMethods: ['browser'],
  installed: true,
  version: '2.1.140',
};

/** 0.63.0：首个 Claude 账号用的是本机终端里的登录。 */
export const localClaudeAccount: AccountState = {
  ...claudeAccount,
  id: 'claude',
  label: '主号',
  localLogin: true,
  multiAccount: true,
};

export const signingInAccount: AccountState = {
  kind: 'chatgpt',
  status: 'signing_in',
  login: {
    loginId: '27c40a56-caa5-4314-9ca0-f2606104ac35',
    method: 'device_code',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-1234',
    startedAt: TS,
  },
};

export const session: Session = {
  id: ids.session,
  workspaceId: ids.workspace,
  cwd: '/Users/me/projects/wevir',
  engine: { kind: 'dsh', sessionId: '6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14' },
  providerId: 'deepseek-official',
  modelId: 'deepseek-chat',
  reasoningEffort: 'high',
  permissionMode: 'on_request',
  title: '整理本周周报',
  titleSource: 'first_prompt',
  state: 'awaiting_approval',
  activeTurn: { turnId: ids.turn, startedAt: TS, clientMessageId: 'msg-1' },
  createdAt: TS,
  updatedAt: TS2,
  lastSeq: 12,
};

/** 会话目标（0.35.0）。 */
export const sessionGoal: SessionGoal = {
  objective: '把登录页的测试补齐并全部通过',
  status: 'active',
  tokenBudget: 200000,
  tokensUsed: 18420,
  timeUsedSeconds: 312,
  updatedAt: TS2,
};

/** 接力过的会话（0.25.0）：先用 DeepSeek，再换到 Claude Agent。 */
export const handedOffSession: Session = {
  ...session,
  engine: { kind: 'codex', sessionId: 'claude-6a1e0c2f' },
  providerId: 'claude',
  modelId: 'claude-opus-5-5',
  state: 'idle',
  engines: [
    {
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      sessionId: '6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14',
      seenSeq: 11,
    },
    { providerId: 'claude', modelId: 'claude-opus-5-5', sessionId: 'claude-6a1e0c2f', seenSeq: 0 },
  ],
};

/** 规则文件（0.68.0）：换到 Claude 后，它自己读 CLAUDE.md，AGENTS.md 与 Cursor 规则由 Host 补给。 */
export const sessionRules: SessionRules = {
  providerId: 'claude',
  files: [
    {
      path: '/Users/me/.claude/CLAUDE.md',
      scope: 'user',
      kind: 'claude',
      delivery: 'engine',
      bytes: 412,
    },
    {
      path: '/Users/me/projects/wevir/AGENTS.md',
      scope: 'project',
      kind: 'agents',
      delivery: 'wevir',
      bytes: 9120,
    },
    {
      path: '/Users/me/projects/wevir/CLAUDE.md',
      scope: 'project',
      kind: 'claude',
      delivery: 'engine',
      bytes: 38,
    },
    {
      path: '/Users/me/projects/wevir/.cursor/rules/style.mdc',
      scope: 'project',
      kind: 'cursor',
      delivery: 'skipped',
      bytes: 9120,
      skipReason: 'duplicate',
    },
  ],
  channel: 'instructions',
  bytes: 9390,
  budgetBytes: 32768,
};

/** 接力过、记下了规则文件的会话（0.68.0）。 */
export const sessionWithRules: Session = { ...handedOffSession, rules: sessionRules };

/** 支线会话（0.17.0）。 */
const { activeTurn: _activeTurn, ...idleSession } = session;
export const sideSession: Session = {
  ...idleSession,
  id: 'ses_01JA2B3C4D5E6F7G8H9JKMNPR3',
  title: '',
  state: 'idle',
  forkedFrom: { sessionId: ids.session, turnId: ids.turn },
  side: true,
  lastSeq: 1,
};

/** 分支到新会话（0.38.0）：顶层会话，带着到 `turnId` 为止的历史。 */
export const branchSession: Session = {
  ...idleSession,
  id: 'ses_01JA2B3C4D5E6F7G8H9JKMNPR4',
  forkedFrom: { sessionId: ids.session, turnId: ids.turn },
  lastSeq: 9,
};

export const toolDisplay: ToolDisplay = {
  kind: 'write',
  summary: '/tmp/wevir-outside.txt',
  paths: ['/tmp/wevir-outside.txt'],
};

export const pendingApproval: ApprovalRequest = {
  id: ids.approval,
  sessionId: ids.session,
  turnId: ids.turn,
  toolCallId: 'call_mv4pwxip_1',
  options: [
    { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once', category: 'allow' },
    { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' },
  ],
  detail: {
    toolName: 'write',
    display: toolDisplay,
    input: {
      file_path: '/tmp/wevir-outside.txt',
      content: 'hello',
      sandbox_permissions: 'danger-full-access',
      justification: 'write outside workspace',
    },
    justification: 'write outside workspace',
    sandboxPermissions: 'danger-full-access',
  },
  status: 'pending',
  createdAt: TS,
};

export const userResolution: ApprovalResolution = {
  optionId: 'allow-once',
  decidedBy: { deviceId: 'dev-6f1c2a', clientId: 'desk-81d0aa', clientKind: 'desktop' },
  reason: 'user',
};

/** 引擎会话丢失后只读的会话（0.3.0）。 */
export const readOnlySession: Session = {
  id: ids.session,
  workspaceId: ids.workspace,
  cwd: '/Users/me/projects/wevir',
  engine: { kind: 'dsh', sessionId: '6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14' },
  providerId: 'deepseek-official',
  modelId: 'deepseek-chat',
  title: '整理本周周报',
  titleSource: 'first_prompt',
  state: 'error',
  lastError: {
    category: 'session_unavailable',
    message:
      'session/resume 失败：Invalid params: session is not resumable: 6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14',
  },
  readOnly: {
    reason: 'engine_session_not_found',
    message:
      'session/resume 失败：Invalid params: session is not resumable: 6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14',
    since: TS2,
  },
  createdAt: TS,
  updatedAt: TS2,
  lastSeq: 30,
};

/** Codex 的子 agent 对应的子会话（0.6.0），在等审批。 */
export const childSession: Session = {
  id: ids.childSession,
  workspaceId: ids.workspace,
  cwd: '/Users/me/projects/wevir',
  engine: { kind: 'codex', sessionId: '01a13896-dd36-7081-85e1-ba12e0474029' },
  providerId: 'deepseek-official',
  modelId: 'deepseek-chat',
  reasoningEffort: 'medium',
  title: '核对周报里的提交数',
  titleSource: 'generated',
  state: 'awaiting_approval',
  activeTurn: { turnId: ids.childTurn, startedAt: TS },
  parentSessionId: ids.session,
  subagent: {
    parentToolCallId: 'call_wevir_spawn_1',
    parentTurnId: ids.turn,
    status: 'running',
    startedAt: TS,
  },
  createdAt: TS,
  updatedAt: TS2,
  lastSeq: 9,
};

export const childApproval: ApprovalRequest = {
  ...pendingApproval,
  id: ids.childApproval,
  sessionId: ids.childSession,
  turnId: ids.childTurn,
  toolCallId: 'call_child_1',
  options: [
    { optionId: 'accept', label: '是，继续', kind: 'allow_accept', category: 'allow' },
    { optionId: 'decline', label: '否，不运行并继续', kind: 'reject_decline', category: 'reject' },
  ],
};

export const subagentSummary: SubagentSummary = {
  sessionId: ids.childSession,
  parentToolCallId: 'call_wevir_spawn_1',
  parentTurnId: ids.turn,
  title: '核对周报里的提交数',
  modelId: 'deepseek-chat',
  reasoningEffort: 'medium',
  nickname: 'Kuhn',
  status: 'running',
  startedAt: TS,
  pendingApprovals: [childApproval],
};

const { nickname: _nickname, ...startedSummary } = { ...subagentSummary, pendingApprovals: [] };

/** 等待中的插话（R11）。 */
export const pendingSteer: PendingMessage = {
  id: ids.pending,
  content: [{ type: 'text', text: '顺便把测试也跑一下' }],
  delivery: 'steer',
  status: 'waiting',
  clientMessageId: 'msg-3',
  sentBy: identity,
  from: { sessionId: ids.childSession, kind: 'message', reportBack: true },
  createdAt: TS,
  updatedAt: TS,
};

/** 插话没插成、转为排队后暂停（R11）。 */
export const pendingHeld: PendingMessage = {
  id: ids.pending2,
  content: [{ type: 'text', text: '然后提交' }],
  delivery: 'queue',
  status: 'held',
  fallback: { reason: 'rejected', message: 'cannot steer a review turn' },
  collaborationMode: 'plan',
  sentBy: identity,
  createdAt: TS,
  updatedAt: TS2,
};

/** 一组问题（0.10.0）：一个单选、一个多选。 */
export const pendingQuestion: QuestionRequest = {
  id: ids.question,
  sessionId: ids.session,
  turnId: ids.turn,
  toolCallId: 'call_ask_1',
  questions: [
    {
      id: 'scope',
      header: '范围',
      question: '这次改动做到哪一步？',
      options: [
        { label: '只做界面', description: '协议另开任务' },
        { label: '全链路', description: '协议、Host 与界面一起' },
      ],
      allowOther: true,
    },
    {
      id: 'targets',
      question: '要覆盖哪些平台？',
      options: [{ label: 'macOS' }, { label: 'Windows' }, { label: 'Linux' }],
      multiSelect: true,
    },
  ],
  status: 'pending',
  createdAt: TS,
};

export const snapshot: SessionSnapshot = {
  session,
  pendingApprovals: [pendingApproval],
  todos: [{ content: '列出本周提交', status: 'in_progress' }],
  usage: {
    contextUsed: 5120,
    contextSize: 262144,
    totalTokens: 182400,
    autoCompactAt: 235929,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 9600, kind: 'used' },
        { name: 'Messages', tokens: 105200, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
        { name: 'Free space', tokens: 297700, kind: 'free' },
        { name: 'MCP tools (deferred)', tokens: 274800, kind: 'deferred' },
      ],
      groups: [
        {
          group: 'memory_files',
          count: 2,
          items: [
            { name: '/Users/me/projects/wevir/AGENTS.md', source: 'Project', tokens: 2400 },
            { name: '/Users/me/.claude/CLAUDE.md', source: 'User', tokens: 600 },
          ],
        },
      ],
    },
  },
};

// ── 事件 payload：键必须覆盖全部事件类型（编译期穷尽） ───────────────────

type PayloadSamples = {
  [T in WevirEventType]: { valid: WevirEventPayload<T>; invalid: unknown };
};

export const eventPayloads: PayloadSamples = {
  'session.created': {
    valid: {
      workspaceId: ids.workspace,
      cwd: '/Users/me/projects/wevir',
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      reasoningEffort: 'high',
      permissionMode: 'full_access',
      engineVersion: '0.2.1-alpha.2',
      environmentId: ids.environment,
      extraRoots: ['/Users/me/projects/wevir-api'],
      worktrees: [
        {
          workspaceId: ids.workspace,
          path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-wevir',
          branch: 'wevir/jkmnpqr0',
        },
      ],
      openedBy: { sessionId: ids.childSession, role: 'explorer' },
      toolPreset: { id: 'core', groups: ['browser'] },
    },
    invalid: { workspaceId: ids.workspace, cwd: '/x', providerId: 'DeepSeek', modelId: 'm' },
  },
  'session.resumed': {
    valid: { engineVersion: '0.2.1-alpha.2' },
    invalid: { engineVersion: 2 },
  },
  'session.read_only': {
    valid: {
      reason: 'engine_session_incompatible',
      message:
        'session/resume 失败：Internal error: session "6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14" uses log format v5, but this harness reads only v4: the log was written by a newer harness — upgrade the harness to open it',
    },
    invalid: { reason: 'engine_session_missing', message: 'x' },
  },
  'session.configured': {
    valid: { modelId: 'deepseek-v4-pro', reasoningEffort: 'high', permissionMode: 'auto_review' },
    invalid: { modelId: 'deepseek-v4-pro', permissionMode: 'yolo' },
  },
  'session.handoff': {
    valid: {
      from: {
        providerId: 'deepseek-official',
        modelId: 'deepseek-chat',
        engineSessionId: '6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14',
      },
      to: { providerId: 'claude', modelId: 'claude-opus-5-5', engineSessionId: 'claude-6a1e0c2f' },
      permissionMode: 'on_request',
      resumed: false,
      strategy: 'full_thread_summary',
      covered: { fromSeq: 1, toSeq: 11 },
      items: 2,
      omittedItems: 1,
      context: 'Context handoff (full_thread_summary):\n…',
      engineVersion: '2.1.0',
      bytes: 2336,
      budgetBytes: 16000,
      hash: '9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a',
      omitted: [{ first: 'e4', last: 'e4', count: 1 }],
      historyTool: true,
      constraints: 1,
      notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
    },
    invalid: {
      from: { providerId: 'deepseek-official', modelId: 'deepseek-chat', engineSessionId: 'e1' },
      to: { providerId: 'Claude', modelId: 'claude-opus-5-5', engineSessionId: 'e2' },
      resumed: false,
      strategy: 'full_thread_summary',
      items: 0,
      omittedItems: 0,
    },
  },
  'session.rules': {
    valid: { ...sessionRules, engineSessionId: 'claude-6a1e0c2f' },
    invalid: {
      ...sessionRules,
      engineSessionId: 'claude-6a1e0c2f',
      files: [{ ...sessionRules.files[0], delivery: 'model' }],
    },
  },
  'session.goal_changed': {
    valid: { goal: sessionGoal },
    invalid: { goal: { ...sessionGoal, status: 'running' } },
  },
  'session.title_changed': {
    valid: { title: '整理本周周报', source: 'first_prompt' },
    invalid: { title: '整理本周周报', source: 'engine' },
  },
  'session.state_changed': {
    valid: { from: 'running', to: 'awaiting_approval', reason: 'approval_requested' },
    invalid: { from: 'running', to: 'paused', reason: 'approval_requested' },
  },
  'user.message': {
    valid: {
      turnId: ids.turn,
      clientMessageId: 'msg-1',
      content: [{ type: 'text', text: '帮我整理本周周报' }, imagePart],
      sentBy: identity,
      pendingId: ids.pending2,
      from: { sessionId: ids.childSession, kind: 'report' },
      collaborationMode: 'plan',
    },
    invalid: { turnId: ids.turn, content: [], sentBy: identity },
  },
  'turn.started': {
    valid: { turnId: ids.turn, trigger: 'goal' },
    invalid: { turnId: ids.turn, trigger: 'plan' },
  },
  'turn.finished': {
    valid: {
      turnId: ids.turn,
      outcome: 'completed',
      engineStopReason: 'end_turn',
      durationMs: 5250,
    },
    invalid: { turnId: ids.turn, outcome: 'done', durationMs: 5250 },
  },
  'turn.rewound': {
    valid: { turnId: ids.turn },
    invalid: { turnId: 'turn-1' },
  },
  'turn.undone': {
    valid: { turnId: ids.turn, files: { status: 'restored', fileCount: 3 } },
    invalid: { turnId: ids.turn, files: { status: 'done' } },
  },
  'turn.redone': {
    valid: { turnId: ids.turn, files: { status: 'unavailable', reason: 'not_git' } },
    invalid: { turnId: 'turn-1' },
  },
  'assistant.delta': {
    valid: { turnId: ids.turn, streamId: ids.stream, blockIndex: 0, kind: 'text', text: '好的，' },
    invalid: { turnId: ids.turn, streamId: ids.stream, blockIndex: 0, kind: 'tool', text: 'x' },
  },
  'assistant.stream_ended': {
    valid: { turnId: ids.turn, streamId: ids.stream, outcome: 'committed' },
    invalid: { turnId: ids.turn, streamId: ids.stream, outcome: 'ok' },
  },
  'assistant.message': {
    valid: {
      turnId: ids.turn,
      messageId: '0f5e2d9c-41b7-4c1a-8e3d-6a2b9c0d1e7f',
      text: '好的，我来整理。',
      replaces: [{ streamId: ids.stream, blockIndex: 0 }],
    },
    invalid: { turnId: ids.turn, messageId: 'm', text: 'x' },
  },
  'assistant.thought': {
    valid: {
      turnId: ids.turn,
      messageId: '0f5e2d9c-41b7-4c1a-8e3d-6a2b9c0d1e7f',
      text: '先列出提交记录。',
      replaces: [],
    },
    invalid: {
      turnId: ids.turn,
      messageId: 'm',
      text: 'x',
      replaces: [{ streamId: ids.stream, blockIndex: -1 }],
    },
  },
  'tool.started': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_1',
      toolName: 'write',
      display: toolDisplay,
      input: { file_path: '/tmp/wevir-outside.txt', content: 'hello' },
    },
    invalid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_1',
      toolName: 'write',
      display: { kind: 'delete' },
    },
  },
  'tool.updated': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_2',
      output: { text: 'partial', truncated: false },
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_2', output: { text: 'partial' } },
  },
  'tool.finished': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_2',
      status: 'completed',
      output: { text: 'ok', truncated: true, originalLength: 70000 },
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_2', status: 'in_progress' },
  },
  'todo.updated': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_0',
      items: [{ content: '列出本周提交', status: 'in_progress' }],
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_0', items: [{ content: 'x' }] },
  },
  'plan.proposed': {
    valid: {
      turnId: ids.turn,
      planId: 'item_plan_1',
      text: '# 周报自动化\n\n## 概述\n\n每周五从提交记录生成周报草稿。\n\n## 测试\n\n- 空周\n',
    },
    invalid: { turnId: ids.turn, planId: '', text: '# 计划' },
  },
  'plan.delta': {
    valid: { turnId: ids.turn, planId: 'item_plan_1', text: '# 周报自动化\n\n## 概' },
    invalid: { turnId: ids.turn, planId: 'item_plan_1', text: '', restart: true },
  },
  'approval.requested': {
    valid: { approval: pendingApproval },
    invalid: { approval: { ...pendingApproval, options: [] } },
  },
  'approval.resolved': {
    valid: { approvalId: ids.approval, status: 'approved', resolution: userResolution },
    invalid: { approvalId: ids.approval, status: 'pending', resolution: userResolution },
  },
  'question.requested': {
    valid: { question: pendingQuestion },
    invalid: { question: { ...pendingQuestion, questions: [] } },
  },
  'question.resolved': {
    valid: {
      questionId: ids.question,
      status: 'answered',
      resolution: {
        reason: 'user',
        answers: { scope: { answers: ['全链路'] }, targets: { answers: ['macOS', 'Linux'] } },
        answeredBy: identity,
      },
    },
    invalid: { questionId: ids.question, status: 'pending', resolution: { reason: 'user' } },
  },
  'usage.updated': {
    valid: {
      contextUsed: 5120,
      contextSize: 262144,
      totalTokens: 182400,
      autoCompactAt: 235929,
      breakdown: {
        categories: [
          { name: 'System prompt', tokens: 9600, kind: 'used' },
          { name: 'Messages', tokens: 105200, kind: 'used' },
          { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
          { name: 'Free space', tokens: 297700, kind: 'free' },
          { name: 'MCP tools (deferred)', tokens: 274800, kind: 'deferred' },
        ],
        groups: [
          {
            group: 'memory_files',
            count: 2,
            items: [
              { name: '/Users/me/projects/wevir/AGENTS.md', source: 'Project', tokens: 2400 },
              { name: '/Users/me/.claude/CLAUDE.md', source: 'User', tokens: 600 },
            ],
          },
        ],
      },
    },
    invalid: { contextUsed: 5120, contextSize: 262144, totalTokens: -1 },
  },
  'context.compacting': {
    valid: { turnId: ids.turn, compactionId: 'cmp-1', trigger: 'auto' },
    invalid: { turnId: ids.turn, compactionId: 'cmp-1', trigger: 'scheduled' },
  },
  'context.compacted': {
    valid: { turnId: ids.turn, compactionId: 'cmp-1', trigger: 'manual' },
    invalid: { turnId: ids.turn, compactionId: '', trigger: 'manual' },
  },
  'engine.error': {
    valid: {
      category: 'missing_credentials',
      message: 'turn failed: llm-deepseek: no API key for provider route deepseek-official',
      code: -32603,
      turnId: ids.turn,
      fatal: false,
    },
    invalid: { category: 'missing_credentials', message: 'x' },
  },
  'engine.raw': {
    valid: {
      protocol: 'acp',
      method: 'session/update',
      kind: 'config_option_update',
      params: { sessionUpdate: 'config_option_update' },
    },
    invalid: { protocol: '', method: 'session/update' },
  },
  'subagent.started': {
    valid: { subagent: startedSummary },
    invalid: { subagent: { ...subagentSummary, status: 'pending_init' } },
  },
  'subagent.updated': {
    valid: { subagent: subagentSummary },
    invalid: { subagent: { ...subagentSummary, pendingApprovals: undefined } },
  },
  'tasks.suggested': {
    valid: { toolCallId: 'call_suggest_1', turnId: ids.turn, tasks: [suggestedTask] },
    invalid: { toolCallId: 'call_suggest_1', tasks: [] },
  },
  'tasks.board_updated': {
    valid: { tasks: [boardTask, waitingBoardTask] },
    invalid: { tasks: [{ ...boardTask, status: 'blocked' }] },
  },
  'suggestion.updated': {
    valid: { turnId: ids.turn, text: '跑一下测试' },
    invalid: { turnId: ids.turn, text: '' },
  },
  'task.started': {
    valid: { taskId: ids.task, sessionId: ids.childSession },
    invalid: { taskId: 'tsk_', sessionId: ids.childSession },
  },
  'task.reported': {
    valid: {
      taskId: ids.task,
      sessionId: ids.childSession,
      outcome: 'completed',
      summary: '三个函数都补了测试，pnpm test 通过。',
    },
    invalid: { taskId: ids.task, sessionId: ids.childSession, outcome: 'done' },
  },
  'pending.added': {
    valid: { pending: pendingSteer },
    invalid: { pending: { ...pendingSteer, delivery: 'interrupt' } },
  },
  'pending.updated': {
    valid: { pending: pendingHeld },
    invalid: { pending: { ...pendingHeld, fallback: { reason: 'timeout' } } },
  },
  'user.steered': {
    valid: {
      turnId: ids.turn,
      pendingId: ids.pending,
      clientMessageId: 'msg-3',
      content: [{ type: 'text', text: '顺便把测试也跑一下' }],
      sentBy: identity,
      from: { sessionId: ids.childSession, kind: 'message' },
    },
    invalid: { turnId: ids.turn, content: [{ type: 'text', text: 'x' }], sentBy: identity },
  },
  'ui.show': {
    valid: { target: { kind: 'file', path: 'docs/report.md', line: 12 }, turnId: ids.turn },
    invalid: { target: { kind: 'file', path: 'docs/report.md', line: 0 } },
  },
  'file.shared': {
    valid: {
      files: [
        {
          path: 'out/周报.docx',
          name: '周报.docx',
          size: 18_432,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        { path: 'chart.png', name: 'chart.png', size: 0 },
      ],
      turnId: ids.turn,
    },
    invalid: { files: [], turnId: ids.turn },
  },
  'verification.updated': {
    valid: { run: verificationRun },
    invalid: { run: { ...verificationRun, status: 'green' } },
  },
  'acceptance.changed': {
    valid: { acceptance },
    invalid: { acceptance: { status: 'done', updatedAt: TS } },
  },
  'repair.updated': {
    valid: { repair: repairChain },
    invalid: { repair: { ...repairChain, attempt: -1 } },
  },
};

export function eventOf<T extends WevirEventType>(type: T, seq = 7): WevirEventOf<T> {
  const engineTypes: string[] = ['assistant.delta', 'assistant.message', 'tool.started'];
  return {
    seq,
    sessionId: ids.session,
    ts: TS,
    type,
    source: engineTypes.includes(type) ? 'engine' : 'host',
    payload: eventPayloads[type].valid,
  } as unknown as WevirEventOf<T>;
}

// ── 方法：键必须覆盖全部方法（编译期穷尽） ─────────────────────────────

type MethodSamples = {
  [M in MethodName]: {
    params: { valid: MethodParams<M>[]; invalid: unknown[] };
    result: { valid: MethodResult<M>[]; invalid: unknown[] };
  };
};

const empty = { valid: [{}], invalid: [null, 'x'] };

const automationRunSample: AutomationRun = {
  id: ids.automationRun,
  automationId: ids.automation,
  trigger: 'schedule',
  status: 'completed',
  startedAt: '2026-10-20T20:00:00.000Z',
  finishedAt: '2026-10-20T20:03:12.000Z',
  sessionId: ids.session,
  turnId: ids.turn,
  summary: '没有过期的依赖。',
};

const automationRunFailedSample: AutomationRun = {
  id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPR1',
  automationId: ids.automation,
  trigger: 'catch_up',
  status: 'failed',
  startedAt: '2026-10-19T20:00:00.000Z',
  finishedAt: '2026-10-19T20:00:01.000Z',
  error: 'provider deepseek not found',
};

const automationSample: Automation = {
  id: ids.automation,
  title: '依赖更新检查',
  prompt: '检查过期的依赖与安全公告。',
  schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
  timezone: 'Pacific/Auckland',
  enabled: true,
  workspaceId: ids.workspace,
  providerId: 'deepseek',
  modelId: 'deepseek-chat',
  permissionMode: 'auto_review',
  newSessionEachRun: true,
  notify: 'always',
  createdBy: { kind: 'agent', sessionId: ids.session },
  createdAt: '2026-10-18T01:00:00.000Z',
  updatedAt: '2026-10-20T20:03:12.000Z',
  nextRunAt: '2026-10-21T20:00:00.000Z',
  lastRun: automationRunSample,
  runCount: 3,
};

const connector = {
  id: 'con_test',
  name: 'sample',
  config: { transport: 'stdio' as const, command: 'node', env: { KEY: true as const } },
  enabled: true,
};
const skill = {
  id: 'skl_test',
  name: 'sample',
  description: 'A sample skill',
  source: 'wevir' as const,
  path: '/data/plugins/skills/sample/SKILL.md',
  enabled: true,
};
const pluginList = { connectors: [connector], skills: [skill] };
const plugin = {
  id: 'sample-plugin',
  name: 'Sample plugin',
  version: '1.2.0',
  author: { name: 'Sample' },
  source: 'wevir' as const,
  enabled: true,
  path: '/data/plugins/packages/sample-plugin',
  inputs: [
    { key: 'TOKEN', label: 'Token', secret: true, required: true, set: true },
    { key: 'REGION', label: 'Region', secret: false, required: false, set: true, value: 'eu' },
  ],
  connectors: ['con_plugin'],
  skills: ['skl_plugin'],
};
const pluginConnector = {
  id: 'con_plugin',
  name: 'sample-plugin_api',
  pluginId: plugin.id,
  missingInputs: ['TOKEN'],
  config: {
    transport: 'stdio' as const,
    command: 'node',
    args: [`\${pluginDir}/server.mjs`, `\${input:REGION}`],
    env: { TOKEN: true as const },
  },
  enabled: true,
};
const pluginList042 = {
  connectors: [connector, pluginConnector],
  skills: [skill, { ...skill, id: 'skl_plugin', name: 'plugin-skill', pluginId: plugin.id }],
  plugins: [plugin],
};

/** 0.57.0：一条项目笔记。 */
const memorySummary: MemorySummary = {
  scope: 'project',
  name: 'invoice-cents',
  type: 'feedback',
  description: 'Discounts are computed in integer cents',
  updatedAt: TS,
  enabled: true,
  revision: '3f1c2a9b7d4e6f10',
};
const memoryNote: MemoryNote = {
  ...memorySummary,
  content: 'Compute discounts in integer cents and round once.\nWhy: the user corrected this.',
};
/** 0.58.0：Agent 在一个回合里存下、之后用户在设置里改过的笔记。 */
const memorySourced: MemoryNote = {
  ...memoryNote,
  origin: { by: 'agent', at: TS, sessionId: ids.session, turnId: ids.turn, seq: 12 },
  lastEdit: { by: 'user', at: TS },
};

/** 0.62.0：一组请求的合计。 */
const usageAggregate = {
  requests: 1_212,
  tokens: {
    input: 2_424,
    output: 1_450_210,
    cacheRead: 227_000_000,
    cacheWrite: 512_340,
    reasoning: 0,
  },
  cost: 87.05,
  unpriced: 3,
  timing: {
    timedRequests: 900,
    outputTokens: 1_300_000,
    durationMs: 14_400_000,
    firstTokenCount: 800,
    firstTokenMs: 1_280_000,
  },
};

/** 会话全文搜索（0.72.0）。 */
export const searchHit: MethodResult<'search.query'>['hits'][number] = {
  sessionId: ids.session,
  workspaceId: ids.workspace,
  sessionTitle: '修复登录流程',
  seq: 12,
  itemId: 'e12',
  turnId: ids.turn,
  kind: 'assistant_message',
  providerId: 'deepseek-official',
  ts: TS,
  snippet: '…已把 packages/host/src/event-store.ts 的登录审批改为…',
  highlights: [{ start: 3, end: 36 }],
};
export const searchIndexStatus: MethodResult<'search.status'> = {
  state: 'ready',
  fts: true,
  pendingSessions: 0,
  pendingEvents: 0,
};

export const methodSamples: MethodSamples = {
  'plugins.list': {
    params: empty,
    result: {
      valid: [pluginList, pluginList042],
      invalid: [{ connectors: [] }, { ...pluginList042, plugins: [{ ...plugin, source: 'npm' }] }],
    },
  },
  'connector.add': {
    params: {
      valid: [
        {
          name: 'sample',
          config: { transport: 'stdio', command: 'node', env: { KEY: 'input-only' } },
        },
        {
          name: 'remote',
          config: {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'input-only' },
            toolTimeoutSec: 20,
          },
        },
      ],
      invalid: [
        { name: 'wevir_bad', config: { transport: 'stdio', command: 'node' } },
        { name: 'Upper', config: { transport: 'stdio', command: 'node' } },
      ],
    },
    result: {
      valid: [{ connector }],
      invalid: [
        {
          connector: {
            ...connector,
            config: { transport: 'stdio', command: 'node', env: { KEY: 'must-not-return' } },
          },
        },
      ],
    },
  },
  'connector.update': {
    params: {
      valid: [
        { id: connector.id, config: { transport: 'stdio', env: { NEW: 'input-only', KEY: null } } },
      ],
      invalid: [{}],
    },
    result: { valid: [{ connector }], invalid: [{}] },
  },
  'connector.remove': { params: { valid: [{ id: connector.id }], invalid: [{}] }, result: empty },
  'connector.setEnabled': {
    params: { valid: [{ id: connector.id, enabled: false }], invalid: [{ id: connector.id }] },
    result: { valid: [{ connector }], invalid: [{}] },
  },
  'skill.install': {
    params: { valid: [{ path: '/tmp/skill.zip' }, { path: '/tmp/SKILL.md' }], invalid: [{}] },
    result: { valid: [pluginList], invalid: [{}] },
  },
  'skill.remove': { params: { valid: [{ id: skill.id }], invalid: [{}] }, result: empty },
  'skill.setEnabled': {
    params: { valid: [{ id: skill.id, enabled: false }], invalid: [{ id: skill.id }] },
    result: { valid: [{ skill }], invalid: [{}] },
  },
  'plugin.install': {
    params: {
      valid: [
        { path: '/tmp/sample-plugin' },
        { path: '/tmp/sample-plugin.zip', inputs: { TOKEN: 'input-only' }, replace: true },
      ],
      invalid: [{}, { path: '/tmp/x', inputs: { 'bad-key': 'x' } }],
    },
    result: {
      valid: [
        { plugin, ignored: [] },
        { plugin: { ...plugin, source: 'claude' }, ignored: ['hooks', 'commands'] },
      ],
      invalid: [{ plugin }, { plugin: { ...plugin, inputs: undefined }, ignored: [] }],
    },
  },
  'plugin.remove': { params: { valid: [{ id: plugin.id }], invalid: [{}] }, result: empty },
  'plugin.setEnabled': {
    params: { valid: [{ id: plugin.id, enabled: false }], invalid: [{ id: plugin.id }] },
    result: { valid: [{ plugin }], invalid: [{}] },
  },
  'plugin.setInputs': {
    params: {
      valid: [{ id: plugin.id, values: { TOKEN: 'input-only', REGION: null } }],
      invalid: [{ id: plugin.id }, { id: plugin.id, values: { TOKEN: 1 } }],
    },
    result: { valid: [{ plugin }], invalid: [{}] },
  },
  'host.hello': {
    params: {
      valid: [
        {
          token: 'test-token-not-a-secret',
          protocolVersion: '0.1.0',
          clientKind: 'desktop',
          deviceId: 'dev-6f1c2a',
          clientId: 'desk-81d0aa',
          capabilities: {},
        },
      ],
      invalid: [
        {
          token: 't',
          protocolVersion: '0.1',
          clientKind: 'cli',
          deviceId: 'd',
          clientId: 'c',
          capabilities: {},
        },
        {
          token: 't',
          protocolVersion: '0.1.0',
          clientKind: 'browser',
          deviceId: 'd',
          clientId: 'c',
          capabilities: {},
        },
      ],
    },
    result: {
      valid: [
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.1.0',
          minProtocolVersion: '0.1.0',
          features: {},
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.7.0',
          minProtocolVersion: '0.1.0',
          features: { chatgpt_account: true },
          permissions: ['host.manage', 'provider.read', 'provider.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.18.0',
          minProtocolVersion: '0.1.0',
          features: { environments: true, session_worktree: true },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.25.0',
          minProtocolVersion: '0.1.0',
          features: { session_handoff: true },
          engineFeatures: {
            'deepseek-official': {
              engine: 'codex',
              steer: true,
              configure: true,
              fork: true,
              permissionModes: ['on_request', 'auto_review', 'full_access'],
              additionalRoots: true,
              historyTool: true,
            },
            claude: { engine: 'claude', configure: true, permissionModes: ['on_request'] },
          },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.27.0',
          minProtocolVersion: '0.1.0',
          features: { session_compact: true, session_review: true },
          engineFeatures: {
            'deepseek-official': { engine: 'codex', commands: ['compact', 'review'] },
            claude: { engine: 'claude', commands: ['compact'] },
            cursor: { engine: 'cursor', commands: [] },
          },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.35.0',
          minProtocolVersion: '0.1.0',
          features: { session_goals: true },
          engineFeatures: {
            'deepseek-official': { engine: 'codex', commands: ['compact', 'review'], goals: true },
            claude: { engine: 'claude', commands: ['compact'] },
            cursor: { engine: 'cursor', commands: [] },
          },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.36.0',
          minProtocolVersion: '0.1.0',
          features: { plan_mode: true },
          engineFeatures: {
            'deepseek-official': {
              engine: 'codex',
              commands: ['compact', 'review'],
              planMode: true,
            },
            claude: { engine: 'claude', commands: ['compact'], planMode: true },
            cursor: { engine: 'cursor', commands: [] },
          },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.38.0',
          minProtocolVersion: '0.1.0',
          features: {
            side_sessions: true,
            session_branches: true,
            session_rewind: true,
            session_undo: true,
          },
          engineFeatures: {
            'deepseek-official': {
              engine: 'codex',
              fork: true,
              commands: ['compact', 'review'],
              branch: true,
              rewind: true,
            },
            claude: { engine: 'claude', fork: true, commands: ['compact'] },
          },
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
      ],
      invalid: [
        {
          hostId: 'host-1',
          hostVersion: '0.0.0',
          protocolVersion: '0.1.0',
          minProtocolVersion: '0.1.0',
          features: {},
          permissions: [],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.25.0',
          minProtocolVersion: '0.1.0',
          features: {},
          engineFeatures: { claude: { steer: true } },
          permissions: [],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.27.0',
          minProtocolVersion: '0.1.0',
          features: {},
          engineFeatures: { claude: { engine: 'claude', commands: ['init'] } },
          permissions: [],
        },
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.36.0',
          minProtocolVersion: '0.1.0',
          features: {},
          engineFeatures: { claude: { engine: 'claude', planMode: 'yes' } },
          permissions: [],
        },
      ],
    },
  },
  'host.ping': { params: empty, result: empty },
  'host.shutdown': { params: empty, result: empty },
  'settings.get': {
    params: empty,
    result: {
      valid: [
        { settings: { sendWhileBusy: 'steer' } },
        { settings: { sendWhileBusy: 'steer', promptSuggestions: true } },
        { settings: { sendWhileBusy: 'steer', sessionRecap: false } },
        // 0.57.0：自动记忆的开关。
        { settings: { sendWhileBusy: 'steer', autoMemory: false } },
        // 0.68.0：跨引擎规则文件的开关。
        { settings: { sendWhileBusy: 'steer', ruleFiles: false } },
      ],
      invalid: [
        { settings: { sendWhileBusy: 'interrupt' } },
        { settings: { sendWhileBusy: 'steer', promptSuggestions: 'yes' } },
        { settings: { sendWhileBusy: 'steer', sessionRecap: 'off' } },
        { settings: { sendWhileBusy: 'steer', autoMemory: 'off' } },
        { settings: { sendWhileBusy: 'steer', ruleFiles: 'on' } },
        {},
      ],
    },
  },
  'settings.update': {
    params: {
      valid: [
        { settings: { sendWhileBusy: 'queue' } },
        { settings: { promptSuggestions: false } },
        { settings: { sessionRecap: false } },
        { settings: { autoMemory: false } },
        { settings: { ruleFiles: false } },
        { settings: {} },
      ],
      invalid: [
        { settings: { sendWhileBusy: 'later' } },
        { settings: { promptSuggestions: 0 } },
        { settings: { sessionRecap: 1 } },
        { settings: { autoMemory: 'no' } },
        { settings: { ruleFiles: 1 } },
        {},
      ],
    },
    result: {
      valid: [
        { settings: { sendWhileBusy: 'queue' } },
        { settings: { sendWhileBusy: 'queue', promptSuggestions: false } },
      ],
      invalid: [{ settings: {} }],
    },
  },
  'workspace.list': {
    params: empty,
    result: {
      valid: [
        { workspaces: [workspace] },
        { workspaces: [workspace, chatsWorkspace] },
        { workspaces: [{ ...workspace, extraFolders: ['/Users/me/projects/wevir-docs'] }] },
      ],
      invalid: [
        { workspaces: [{ id: 'x' }] },
        { workspaces: [{ ...chatsWorkspace, kind: 'repo' }] },
        { workspaces: [{ ...workspace, extraFolders: [''] }] },
        {
          workspaces: [
            { ...workspace, extraFolders: Array.from({ length: 8 }, (_, i) => `/f${i}`) },
          ],
        },
      ],
    },
  },
  'workspace.add': {
    params: {
      valid: [
        { rootPath: '/Users/me/projects/wevir' },
        { rootPath: '/tmp/a', displayName: 'A' },
        { rootPath: '/tmp/a', extraFolders: ['/tmp/b', '/tmp/c'] },
      ],
      invalid: [{ rootPath: '' }, { displayName: 'A' }, { rootPath: '/tmp/a', extraFolders: [''] }],
    },
    result: {
      valid: [{ workspace, created: true }],
      invalid: [{ workspace }],
    },
  },
  'workspace.remove': {
    params: { valid: [{ workspaceId: ids.workspace }], invalid: [{ workspaceId: ids.session }] },
    result: empty,
  },
  'workspace.update': {
    params: {
      valid: [
        { workspaceId: ids.workspace, displayName: 'Wevir 桌面端' },
        { workspaceId: ids.workspace, extraFolders: ['/tmp/b'] },
        { workspaceId: ids.workspace, extraFolders: [] },
        { workspaceId: ids.workspace, displayName: 'A', extraFolders: ['/tmp/b'] },
      ],
      invalid: [
        { workspaceId: ids.workspace, displayName: '' },
        { workspaceId: ids.workspace, extraFolders: [''] },
        { workspaceId: ids.workspace, displayName: 'x'.repeat(201) },
        { workspaceId: ids.session, displayName: 'A' },
        { workspaceId: ids.workspace },
      ],
    },
    result: {
      valid: [{ workspace }, { workspace: chatsWorkspace }],
      invalid: [{}, { workspace: { id: 'x' } }],
    },
  },
  'environment.list': {
    params: empty,
    result: {
      valid: [{ environments: [] }, { environments: [environment] }],
      invalid: [{ environments: [{ ...environment, folders: [] }] }],
    },
  },
  'environment.create': {
    params: {
      valid: [{ name: '前后端一起改', folders: environment.folders }],
      invalid: [
        { name: '', folders: environment.folders },
        { name: 'x', folders: [{ workspaceId: ids.workspace, worktree: 'reuse' }] },
      ],
    },
    result: { valid: [{ environment }], invalid: [{ environment: { ...environment, id: 'x' } }] },
  },
  'environment.update': {
    params: {
      valid: [
        { environmentId: ids.environment },
        { environmentId: ids.environment, name: '新名字' },
      ],
      invalid: [{ environmentId: ids.workspace }, { environmentId: ids.environment, folders: [] }],
    },
    result: { valid: [{ environment }], invalid: [{}] },
  },
  'environment.remove': {
    params: { valid: [{ environmentId: ids.environment }], invalid: [{}] },
    result: empty,
  },
  'workspace.git': {
    params: {
      valid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, sessionId: ids.session },
      ],
      invalid: [{ workspaceId: ids.session }, {}],
    },
    result: {
      valid: [
        { repo: false },
        {
          repo: true,
          branch: 'main',
          added: 12,
          removed: 3,
          fileCount: 3,
          files: [
            { path: 'src/a.ts', status: 'modified', added: 10, removed: 3 },
            { path: 'logo.png', status: 'added' },
            { path: 'notes.md', status: 'untracked' },
          ],
        },
        { repo: true, detachedAt: '1a2b3c4', added: 0, removed: 0, fileCount: 0, files: [] },
        {
          repo: true,
          branch: 'main',
          added: 1,
          removed: 0,
          fileCount: 201,
          files: [{ path: 'a', status: 'modified', added: 1, removed: 0 }],
          truncated: true,
        },
      ],
      invalid: [
        {},
        { repo: true, files: [{ path: '', status: 'modified' }] },
        { repo: true, added: -1 },
      ],
    },
  },
  'workspace.diff': {
    params: {
      valid: [
        { workspaceId: ids.workspace, source: { kind: 'uncommitted' } },
        { workspaceId: ids.workspace, sessionId: ids.session, source: { kind: 'branch' } },
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          source: { kind: 'turn', turnId: ids.turn },
        },
        { workspaceId: ids.workspace, sessionId: ids.session, source: { kind: 'staged' } },
      ],
      invalid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, source: { kind: 'index' } },
        { workspaceId: ids.workspace, source: { kind: 'turn' } },
        { workspaceId: ids.session, source: { kind: 'uncommitted' } },
      ],
    },
    result: {
      valid: [
        { repo: false },
        { repo: true, unavailable: 'no_checkpoint' },
        {
          repo: true,
          base: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          branch: 'main',
          patch:
            'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
          files: [
            { path: 'src/a.ts', status: 'modified', added: 1, removed: 1 },
            { path: 'logo.png', status: 'added', binary: true },
            {
              path: 'big.json',
              status: 'modified',
              added: 90000,
              removed: 0,
              omitted: 'too_large',
            },
            {
              path: 'docs/new.md',
              previousPath: 'docs/old.md',
              status: 'renamed',
              added: 0,
              removed: 0,
            },
          ],
          fileCount: 4,
          added: 90001,
          removed: 1,
          truncated: true,
        },
        {
          repo: true,
          base: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          baseRef: 'origin/main',
          branch: 'feature',
          patch: '',
          files: [],
          fileCount: 0,
          added: 0,
          removed: 0,
        },
        {
          repo: true,
          base: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          head: '0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a',
          patch: '',
          files: [],
          fileCount: 0,
          added: 0,
          removed: 0,
        },
        {
          repo: true,
          base: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          live: true,
          patch: '',
          files: [{ path: 'notes.md', status: 'untracked', omitted: 'over_limit' }],
          fileCount: 1,
          added: 0,
          removed: 0,
          truncated: true,
        },
      ],
      invalid: [
        {},
        { repo: true, base: 'HEAD' },
        { repo: true, files: [{ path: '', status: 'modified' }] },
        { repo: true, live: false },
        { repo: true, added: -1 },
      ],
    },
  },
  'workspace.diffFile': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          oldRev: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
          oldPath: 'src/a.ts',
          newPath: 'src/a.ts',
        },
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          newRev: '0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a',
          newPath: 'src/new.ts',
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, oldRev: 'HEAD', oldPath: 'a' },
        { workspaceId: ids.workspace, newPath: '' },
        { oldPath: 'a' },
      ],
    },
    result: {
      valid: [
        { oldContents: 'old\n', newContents: 'new\n' },
        { newContents: '' },
        { unavailable: 'too_large' },
        { unavailable: 'binary' },
      ],
      invalid: [{ oldContents: 1 }, { unavailable: '' }],
    },
  },
  'workspace.files': {
    params: {
      valid: [
        { workspaceId: ids.workspace, query: '' },
        { workspaceId: ids.workspace, sessionId: ids.session, query: 'comp', limit: 20 },
        { workspaceId: ids.workspace, query: 'src/', kind: 'directory' },
      ],
      invalid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, query: 'a', limit: 0 },
        { workspaceId: ids.workspace, query: 'a', limit: 201 },
        { workspaceId: ids.workspace, query: 'a', kind: 'symlink' },
      ],
    },
    result: {
      valid: [
        {
          entries: [
            { path: 'src', kind: 'directory' },
            { path: 'src/composer.tsx', kind: 'file' },
          ],
        },
        { entries: [], truncated: true },
      ],
      invalid: [{ entries: [{ path: '', kind: 'file' }] }, { entries: [], truncated: false }],
    },
  },
  'workspace.listDir': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: '' },
        { workspaceId: ids.workspace, sessionId: ids.session, path: 'src/lib' },
      ],
      invalid: [{ workspaceId: ids.workspace }, { path: '' }],
    },
    result: {
      valid: [
        {
          entries: [
            { path: 'dist', kind: 'directory', ignored: true },
            { path: 'src', kind: 'directory' },
            { path: 'README.md', kind: 'file' },
          ],
        },
        { entries: [], truncated: true },
      ],
      invalid: [{ entries: [{ path: 'a', kind: 'file', ignored: false }] }, {}],
    },
  },
  'workspace.readFile': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: 'README.md' },
        { workspaceId: ids.workspace, sessionId: ids.session, path: 'assets/logo.png' },
      ],
      invalid: [{ workspaceId: ids.workspace, path: '' }, { workspaceId: ids.workspace }],
    },
    result: {
      valid: [
        { path: 'README.md', size: 6, text: '# Demo' },
        {
          path: 'assets/logo.png',
          size: 68,
          image: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        },
        { path: 'big.log', size: 2_000_000, unavailable: 'too_large' },
        { path: 'gone.txt', unavailable: 'not_found' },
        { path: 'notes.md', size: 7, mtimeMs: 1_760_000_000_123.456, text: '# Notes' },
      ],
      invalid: [
        { size: 1, text: 'x' },
        { path: 'a.png', image: { mimeType: 'image/tiff', data: '' } },
        { path: 'a', unavailable: '' },
        { path: 'a', mtimeMs: -1, text: '' },
      ],
    },
  },
  'workspace.fileUrl': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: 'docs/report.pdf' },
        { workspaceId: ids.workspace, sessionId: ids.session, path: 'site/index.html' },
      ],
      invalid: [{ workspaceId: ids.workspace, path: '' }, { path: 'a.pdf' }],
    },
    result: {
      valid: [
        {
          path: 'docs/report.pdf',
          url: 'http://127.0.0.1:52811/files/Zm9vYmFy/docs/report.pdf',
          size: 123_456,
          mtimeMs: 1_760_000_000_123.456,
          expiresAt: 1_760_003_600_000,
        },
        { path: 'gone.pdf', unavailable: 'not_found' },
      ],
      invalid: [{ url: 'http://127.0.0.1:1/files/x/a' }, { path: 'a', unavailable: '' }],
    },
  },
  'workspace.writeFile': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: 'notes.md', text: '# Notes\n' },
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          path: 'src/app.ts',
          text: '',
          expectedMtimeMs: 1_760_000_000_123.456,
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, path: 'notes.md' },
        { workspaceId: ids.workspace, path: '', text: 'x' },
        { workspaceId: ids.workspace, path: 'a', text: 'x', expectedMtimeMs: -1 },
      ],
    },
    result: {
      valid: [
        { path: 'notes.md', size: 9, mtimeMs: 1_760_000_100_000 },
        { path: 'notes.md', size: 12, mtimeMs: 1_760_000_200_000, conflict: true },
        { path: 'gone.md', conflict: true },
      ],
      invalid: [{ size: 1 }, { path: 'a', conflict: false }],
    },
  },
  'provider.list': {
    params: empty,
    result: {
      valid: [
        { providers: [deepseekProvider, compatibleProvider, chatgptProvider] },
        {
          providers: [{ ...compatibleProvider, enabled: true }, claudeProvider, workbuddyProvider],
        },
      ],
      invalid: [
        { providers: [{ ...compatibleProvider, hasSecret: undefined }] },
        { providers: [{ ...chatgptProvider, kind: 'chatgpt-plus' }] },
        { providers: [{ ...claudeProvider, enabled: 'no' }] },
      ],
    },
  },
  'provider.upsert': {
    params: {
      valid: [
        {
          id: 'deepseek-official',
          kind: 'deepseek-official',
          displayName: 'DeepSeek',
          models: [],
          defaultModelId: 'deepseek-chat',
          apiKey: 'placeholder-not-a-key',
        },
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: '本机 Ollama',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
          apiKey: null,
        },
        { id: 'chatgpt', kind: 'chatgpt', displayName: 'ChatGPT', defaultModelId: 'gpt-6.1-sol' },
        // 0.63.0：添加的 ChatGPT 账号
        {
          id: 'chatgpt-0b1c',
          kind: 'chatgpt',
          displayName: 'ChatGPT',
          defaultModelId: 'gpt-6.1-sol',
        },
      ],
      invalid: [
        // chatgpt 的 id 要合 Provider ID 的格式
        {
          id: 'My ChatGPT',
          kind: 'chatgpt',
          displayName: 'ChatGPT',
          defaultModelId: 'gpt-6.1-sol',
        },
        // deepseek-official 的 id 固定
        {
          id: 'my-deepseek',
          kind: 'deepseek-official',
          displayName: 'DeepSeek',
          models: [],
          defaultModelId: 'deepseek-chat',
        },
        // openai-compatible 必须有 api 与 baseURL
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: 'Ollama',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
        },
        // baseURL 只接受 http / https
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: 'Ollama',
          api: 'openai-completions',
          baseURL: 'localhost:11434',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
        },
      ],
    },
    result: {
      valid: [{ provider: compatibleProvider, created: false }],
      invalid: [{ provider: { ...compatibleProvider, id: 'Local Ollama' }, created: false }],
    },
  },
  'provider.remove': {
    params: { valid: [{ providerId: 'local-ollama' }], invalid: [{ providerId: '1abc' }] },
    result: empty,
  },
  'provider.test': {
    params: {
      valid: [{ providerId: 'local-ollama' }, { providerId: 'local-ollama', modelId: 'qwen3:8b' }],
      invalid: [{ modelId: 'qwen3:8b' }],
    },
    result: {
      valid: [
        { ok: true, latencyMs: 420 },
        { ok: false, error: { category: 'missing_credentials', message: 'no API key' } },
        {
          ok: false,
          latencyMs: 180,
          error: { category: 'provider', message: 'API Key 无效或没有权限（HTTP 401）' },
          reason: 'auth',
          httpStatus: 401,
        },
        {
          ok: false,
          error: { category: 'provider', message: '连不上 127.0.0.1:11434（ECONNREFUSED）' },
          reason: 'network',
        },
      ],
      invalid: [{ ok: 'yes' }, { ok: false, reason: 'teapot' }, { ok: false, httpStatus: 42 }],
    },
  },
  'provider.discoverModels': {
    params: {
      valid: [
        { providerId: 'local-ollama' },
        { baseURL: 'http://127.0.0.1:11434/v1', modelId: 'gpt-oss:20b' },
        { baseURL: 'https://ollama.com/v1', apiKey: 'placeholder-key' },
      ],
      invalid: [
        { providerId: 42 },
        { baseURL: 'file:///tmp/models' },
        { modelId: '' },
        { apiKey: '' },
      ],
    },
    result: {
      valid: [
        { ok: true, models: [] },
        { ok: false, models: [], reason: 'network' },
        {
          ok: true,
          models: [
            {
              model: {
                id: 'gpt-oss:20b',
                contextWindow: 4096,
                reasoningEfforts: ['low', 'medium', 'high'],
              },
              maxContextWindow: 131072,
              contextSource: 'running',
              detailsAvailable: true,
            },
          ],
        },
      ],
      invalid: [
        { ok: true },
        { ok: true, models: [{ model: { id: '' } }] },
        { ok: false, models: [], reason: 'invalid' },
      ],
    },
  },
  'provider.setEnabled': {
    params: {
      valid: [
        { providerId: 'claude', enabled: false },
        { providerId: 'local-ollama', enabled: true },
      ],
      invalid: [{ providerId: 'claude' }, { providerId: 'Claude', enabled: true }],
    },
    result: {
      valid: [{ provider: claudeProvider }],
      invalid: [{ provider: { ...claudeProvider, kind: 'gemini' } }, {}],
    },
  },
  'account.list': {
    params: empty,
    result: {
      valid: [
        { accounts: [signedInAccount, claudeAccount, antigravityInstalling, workbuddyAccount] },
        {
          accounts: [
            {
              kind: 'grok',
              status: 'signed_out',
              signIn: 'command',
              loginCommand: 'grok login',
              installed: false,
              installCommand: 'npm install -g @xai-official/grok',
              installUrl: 'https://x.ai/cli',
            },
          ],
        },
        { accounts: [] },
      ],
      invalid: [
        { accounts: [{ ...claudeAccount, signIn: 'oauth' }] },
        { accounts: [{ ...antigravityInstalling, installing: { completedBytes: -1 } }] },
        {},
      ],
    },
  },
  'account.get': {
    params: {
      valid: [
        { kind: 'chatgpt' },
        { kind: 'claude', refresh: true },
        { kind: 'grok' },
        { kind: 'workbuddy', refresh: true },
        // 0.63.0：按账号 ID 读添加的账号。
        { kind: 'claude', id: 'claude-3f9a', refresh: true },
      ],
      invalid: [
        {},
        { kind: 'gemini' },
        { kind: 'claude', refresh: 'yes' },
        { kind: 'claude', id: 'Claude 2' },
      ],
    },
    result: {
      valid: [
        { account: signedInAccount },
        { account: signingInAccount },
        { account: { kind: 'chatgpt', status: 'signed_out', lastError: 'Login timed out' } },
        { account: claudeAccount },
        { account: multiWindowAccount },
        { account: labeledClaudeAccount },
        { account: localClaudeAccount },
      ],
      invalid: [
        { account: { kind: 'chatgpt', status: 'expired' } },
        { account: { ...labeledClaudeAccount, label: '' } },
        { account: { ...labeledClaudeAccount, label: ' 工作' } },
        { account: { ...labeledClaudeAccount, label: 'x'.repeat(17) } },
        { account: { ...localClaudeAccount, localLogin: false } },
        { account: { ...claudeAccount, installUrl: 'x.ai/cli' } },
        {
          account: {
            ...multiWindowAccount,
            rateLimits: { windows: [{ usedPercent: 1, period: 'yearly' }] },
          },
        },
        {
          account: {
            ...multiWindowAccount,
            rateLimits: { windows: [{ usedPercent: 1, scope: '' }] },
          },
        },
        {},
      ],
    },
  },
  'account.login': {
    params: {
      valid: [
        { kind: 'chatgpt', method: 'browser' },
        { kind: 'chatgpt', method: 'device_code' },
        // 0.56.0：选上游、方式与 Key（给了 upstream 时 method 被忽略）。
        { kind: 'opencode', method: 'browser', upstream: 'github-copilot' },
        { kind: 'opencode', method: 'device_code', upstream: 'openai', option: '1' },
        {
          kind: 'opencode',
          method: 'browser',
          upstream: 'opencode-go',
          apiKey: 'sk-test-not-real',
        },
        { kind: 'opencode', method: 'browser', upstream: 'openai', option: 'default' },
        // 没有 upstream 时 option 是 loginOptions 里的一项。
        { kind: 'workbuddy', method: 'browser', option: 'external' },
        // 0.63.0：登录添加的账号。
        { kind: 'chatgpt', id: 'chatgpt-0b1c', method: 'device_code' },
      ],
      invalid: [
        { kind: 'chatgpt' },
        { kind: 'chatgpt', method: 'api_key' },
        { kind: 'opencode', method: 'browser', upstream: '' },
        { kind: 'opencode', method: 'browser', upstream: 'openai', option: '' },
        { kind: 'opencode', method: 'browser', upstream: 'openai', option: 1 },
        { kind: 'opencode', method: 'browser', upstream: 'openai', apiKey: '' },
        { kind: 'opencode', method: 'browser', upstream: 'openai', apiKey: 'k'.repeat(8193) },
      ],
    },
    result: {
      valid: [
        { account: connectingUpstreamAccount },
        { account: workbuddyLoginAccount },
        {
          account: {
            kind: 'chatgpt',
            status: 'signing_in',
            login: {
              loginId: '7af8e3cc-12e5-47a9-95f2-444009ba644f',
              method: 'browser',
              authUrl: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=x',
              startedAt: TS,
            },
          },
        },
        { account: signingInAccount },
      ],
      invalid: [
        {
          account: {
            ...signingInAccount,
            login: { ...signingInAccount.login, verificationUrl: 'auth.openai.com/codex/device' },
          },
        },
      ],
    },
  },
  'account.cancelLogin': {
    params: {
      valid: [
        { kind: 'chatgpt' },
        { kind: 'chatgpt', loginId: '27c40a56-caa5-4314-9ca0-f2606104ac35' },
        { kind: 'chatgpt', id: 'chatgpt-0b1c' },
      ],
      invalid: [
        { kind: 'chatgpt', loginId: '' },
        { kind: 'chatgpt', id: '' },
      ],
    },
    result: {
      valid: [{ account: { kind: 'chatgpt', status: 'signed_out' } }],
      invalid: [{ account: { status: 'signed_out' } }],
    },
  },
  'account.upstreams': {
    params: { valid: [{ kind: 'opencode' }], invalid: [{}, { kind: 'gemini' }] },
    result: {
      valid: [
        { upstreams: [] },
        {
          upstreams: [
            {
              id: 'opencode',
              name: 'OpenCode',
              connected: true,
              featured: true,
              methods: [{ type: 'api_key', label: 'API key', option: 'default' }],
            },
            {
              id: 'openai',
              name: 'OpenAI',
              connected: false,
              featured: true,
              methods: [
                { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', option: '0' },
                { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', option: '1' },
                { type: 'api_key', label: 'Manually enter API Key', option: '2' },
              ],
            },
          ],
        },
      ],
      invalid: [
        {},
        { upstreams: [{ id: 'openai', name: 'OpenAI', connected: false, featured: true }] },
        {
          upstreams: [
            { id: 'openai', name: 'OpenAI', connected: false, featured: true, methods: [] },
          ],
        },
        {
          upstreams: [
            {
              id: 'openai',
              name: 'OpenAI',
              connected: false,
              featured: true,
              methods: [{ type: 'password', label: 'x', option: '0' }],
            },
          ],
        },
        {
          upstreams: [
            {
              id: 'openai',
              name: 'OpenAI',
              connected: false,
              featured: true,
              methods: [{ type: 'oauth', label: '', option: '0' }],
            },
          ],
        },
        {
          upstreams: [
            {
              id: 'openai',
              name: 'OpenAI',
              connected: false,
              featured: true,
              methods: [{ type: 'oauth', label: 'x', option: 0 }],
            },
          ],
        },
      ],
    },
  },
  'account.logout': {
    params: {
      valid: [
        { kind: 'chatgpt' },
        { kind: 'opencode', upstream: 'opencode-go' },
        { kind: 'grok', id: 'grok-77d0' },
      ],
      invalid: [{ kind: 1 }, { kind: 'opencode', upstream: '' }, { kind: 'grok', id: 7 }],
    },
    result: {
      valid: [{ account: { kind: 'chatgpt', status: 'signed_out' } }],
      invalid: [
        {
          account: {
            ...signedInAccount,
            rateLimits: { primary: { usedPercent: -1 } },
          },
        },
      ],
    },
  },
  'account.setPath': {
    params: {
      valid: [
        { kind: 'claude', path: '/opt/homebrew/bin/claude' },
        { kind: 'opencode', path: null },
      ],
      invalid: [{ kind: 'claude' }, { kind: 'claude', path: '' }],
    },
    result: {
      valid: [{ account: { ...claudeAccount, customPath: '/opt/homebrew/bin/claude' } }],
      invalid: [{ account: { ...claudeAccount, customPath: '' } }],
    },
  },
  'account.install': {
    params: { valid: [{ kind: 'antigravity' }], invalid: [{ kind: 'gemini' }, {}] },
    result: {
      valid: [{ account: antigravityInstalling }],
      invalid: [{ account: { ...antigravityInstalling, canInstall: 'yes' } }],
    },
  },
  'account.add': {
    params: {
      valid: [{ kind: 'claude' }, { kind: 'chatgpt', label: '副号' }],
      invalid: [
        {},
        { kind: 'gemini' },
        { kind: 'claude', label: '' },
        { kind: 'claude', label: 3 },
      ],
    },
    result: {
      valid: [
        {
          account: {
            kind: 'chatgpt',
            id: 'chatgpt-0b1c',
            label: '副号',
            multiAccount: true,
            status: 'signed_out',
            signIn: 'in_app',
            loginMethods: ['browser', 'device_code'],
          },
        },
      ],
      invalid: [{ account: { kind: 'chatgpt', id: 'ChatGPT', status: 'signed_out' } }],
    },
  },
  'account.remove': {
    params: { valid: [{ id: 'claude-3f9a' }], invalid: [{}, { id: '' }, { kind: 'claude' }] },
    result: empty,
  },
  'account.setLabel': {
    params: {
      valid: [
        { id: 'claude', label: '主号' },
        { id: 'claude-3f9a', label: 'Work' },
        { id: 'claude-3f9a', label: null },
      ],
      invalid: [{ id: 'claude' }, { id: 'claude', label: '' }, { id: 'claude', label: '工作 ' }],
    },
    result: {
      valid: [{ account: labeledClaudeAccount }, { account: localClaudeAccount }],
      invalid: [{ account: { ...labeledClaudeAccount, multiAccount: false } }],
    },
  },
  'session.create': {
    params: {
      valid: [
        { workspaceId: ids.workspace, providerId: 'deepseek-official' },
        {
          workspaceId: ids.workspace,
          providerId: 'deepseek-official',
          modelId: 'deepseek-reasoner',
          reasoningEffort: 'max',
          permissionMode: 'full_access',
          environmentId: ids.environment,
        },
        {
          workspaceId: ids.workspace,
          providerId: 'deepseek-official',
          origin: { kind: 'suggested_task', sessionId: ids.session, taskId: ids.task },
        },
        { workspaceId: ids.workspace, providerId: 'deepseek-official', worktree: 'new' },
        { providerId: 'deepseek-official', permissionMode: 'full_access' },
        // 0.61.0：工具预设。
        { providerId: 'deepseek-official', toolPreset: { id: 'full' } },
        {
          workspaceId: ids.workspace,
          providerId: 'deepseek-official',
          toolPreset: { id: 'core', groups: ['browser', 'lsp'] },
        },
      ],
      invalid: [
        { workspaceId: ids.workspace },
        {},
        { workspaceId: ids.workspace, providerId: 'deepseek-official', worktree: 'yes' },
        {
          workspaceId: ids.workspace,
          providerId: 'deepseek-official',
          origin: { kind: 'fork', sessionId: ids.session, taskId: ids.task },
        },
        { workspaceId: ids.workspace, providerId: 'deepseek-official', permissionMode: 'never' },
        { workspaceId: ids.workspace, providerId: 'deepseek-official', environmentId: 'e1' },
        { providerId: 'deepseek-official', toolPreset: { id: 'minimal' } },
        { providerId: 'deepseek-official', toolPreset: { id: 'core', groups: ['terminal'] } },
      ],
    },
    result: {
      valid: [
        { session },
        { session: { ...session, toolPreset: { id: 'core', groups: ['lsp'] } } },
      ],
      invalid: [
        { session: { ...session, state: 'paused' } },
        { session: { ...session, toolPreset: { groups: [] } } },
      ],
    },
  },
  'session.list': {
    params: {
      valid: [
        {},
        { workspaceId: ids.workspace },
        { parentSessionId: ids.session },
        { archived: true },
      ],
      invalid: [{ workspaceId: 'ws_' }, { parentSessionId: ids.workspace }, { archived: 'yes' }],
    },
    result: {
      valid: [
        { sessions: [session] },
        { sessions: [childSession] },
        { sessions: [{ ...session, state: 'closed', archivedAt: TS2 }] },
        { sessions: [{ ...session, openedBy: { sessionId: ids.childSession } }] },
        {
          sessions: [{ ...session, openedBy: { sessionId: ids.childSession, role: 'reviewer' } }],
        },
        { sessions: [{ ...session, state: 'idle', goal: { ...sessionGoal, status: 'paused' } }] },
        // 0.66.0：自动化开出来的会话。
        {
          sessions: [
            { ...session, automation: { automationId: ids.automation, runId: ids.automationRun } },
          ],
        },
      ],
      invalid: [
        { sessions: [{ ...session, lastSeq: -1 }] },
        { sessions: [{ ...session, automation: { automationId: ids.automation } }] },
        { sessions: [{ ...session, openedBy: { sessionId: ids.workspace } }] },
        { sessions: [{ ...session, openedBy: { sessionId: ids.childSession, role: '' } }] },
        { sessions: [{ ...session, archivedAt: 'yesterday' }] },
      ],
    },
  },
  'session.get': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: {
      valid: [
        snapshot,
        { session: { ...session, state: 'idle' }, pendingApprovals: [] },
        { session: { ...session, state: 'idle', collaborationMode: 'plan' }, pendingApprovals: [] },
        { session: readOnlySession, pendingApprovals: [] },
        { ...snapshot, subagents: [subagentSummary] },
        { session: childSession, pendingApprovals: [childApproval] },
        { ...snapshot, suggestedTasks: [suggestedTask, reportedTask] },
        { ...snapshot, taskBoard: [boardTask, waitingBoardTask] },
        { ...snapshot, taskBoard: [] },
        { ...snapshot, promptSuggestion },
      ],
      invalid: [
        { ...snapshot, promptSuggestion: { turnId: ids.turn, text: '' } },
        { ...snapshot, promptSuggestion: { text: '跑一下测试' } },
        { session },
        { ...snapshot, subagents: [{ ...subagentSummary, sessionId: 'x' }] },
        { ...snapshot, taskBoard: [{ ...boardTask, blockedBy: [''] }] },
        { session: { ...session, collaborationMode: 'ask' }, pendingApprovals: [] },
      ],
    },
  },
  'session.configure': {
    params: {
      valid: [
        { sessionId: ids.session, modelId: 'deepseek-v4-pro', reasoningEffort: 'high' },
        { sessionId: ids.session, reasoningEffort: null },
        { sessionId: ids.session, permissionMode: 'auto_review' },
        { sessionId: ids.session, providerId: 'claude', modelId: 'claude-opus-5-5' },
        { sessionId: ids.session, providerId: 'claude' },
        // 0.59.0：必须携带的约束与选入的笔记。
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: {
            constraints: ['金额一律用整数分；测试只用 npm test，不改 test/ 目录。'],
            notes: [
              { scope: 'project', name: 'invoice-cents' },
              { scope: 'global', name: 'reply-language' },
            ],
          },
        },
        // 0.60.0：带预览的绑定。
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: {
            constraints: ['金额一律用整数分。'],
            notes: [{ scope: 'project', name: 'invoice-cents' }],
            binding: {
              providerId: 'claude',
              throughSeq: 11,
              strategy: 'full_thread_summary',
              notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
              hash: '9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a',
            },
          },
        },
      ],
      invalid: [
        { modelId: 'deepseek-v4-pro' },
        { sessionId: ids.session, modelId: '' },
        { sessionId: ids.session, permissionMode: 'ask' },
        { sessionId: ids.session, providerId: 'Claude' },
        { sessionId: ids.session, providerId: 'claude', handoff: { constraints: ['  '] } },
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: { constraints: ['x'.repeat(2001)] },
        },
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: { notes: [{ scope: 'workspace', name: 'invoice-cents' }] },
        },
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: {
            notes: Array.from({ length: 6 }, (_, index) => ({
              scope: 'global',
              name: `n${index}`,
            })),
          },
        },
      ],
    },
    result: {
      valid: [{ session }, { session: handedOffSession }, { session: sessionWithRules }],
      invalid: [
        {},
        {
          session: {
            ...handedOffSession,
            engines: [{ providerId: 'claude', modelId: 'm', sessionId: 'e', seenSeq: -1 }],
          },
        },
      ],
    },
  },
  'session.handoffPreview': {
    params: {
      valid: [
        { sessionId: ids.session, providerId: 'claude' },
        {
          sessionId: ids.session,
          providerId: 'claude',
          handoff: {
            constraints: ['金额一律用整数分。'],
            notes: [{ scope: 'project', name: 'invoice-cents' }],
          },
        },
      ],
      invalid: [
        { sessionId: ids.session },
        { sessionId: ids.session, providerId: 'claude', handoff: { constraints: [''] } },
      ],
    },
    result: {
      valid: [
        {
          preview: {
            providerId: 'claude',
            strategy: 'full_thread_summary',
            resumed: false,
            historyTool: true,
            covered: { fromSeq: 1, toSeq: 11 },
            budgetBytes: 16000,
            items: 2,
            omittedItems: 1,
            omitted: [{ first: 'e4', last: 'e4', count: 1 }],
            context: 'Context handoff (full_thread_summary):\n…',
            bytes: 2336,
            hash: '9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a',
            constraints: 1,
            notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
            // 0.68.0：新来源会加载的规则文件。
            rules: sessionRules,
          },
          binding: {
            providerId: 'claude',
            throughSeq: 11,
            strategy: 'full_thread_summary',
            notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
            hash: '9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a',
          },
        },
        // 换回去时对方什么都没错过：没有材料，绑定里没有散列。
        {
          preview: {
            providerId: 'deepseek-official',
            strategy: 'delta_since_target_last_seen',
            resumed: true,
            historyTool: false,
            budgetBytes: 16000,
            items: 0,
            omittedItems: 0,
            omitted: [],
            constraints: 0,
            notes: [],
          },
          binding: {
            providerId: 'deepseek-official',
            throughSeq: 12,
            strategy: 'delta_since_target_last_seen',
            notes: [],
          },
        },
        // 必须项放不下：没有材料，也没有绑定。
        {
          preview: {
            providerId: 'claude',
            strategy: 'full_thread_summary',
            resumed: false,
            historyTool: true,
            covered: { fromSeq: 1, toSeq: 11 },
            budgetBytes: 16000,
            items: 0,
            omittedItems: 0,
            omitted: [],
            overBudget: { bytes: 18311 },
            constraints: 3,
            notes: [],
          },
        },
      ],
      invalid: [
        {},
        {
          preview: {
            providerId: 'claude',
            strategy: 'full_thread_summary',
            resumed: false,
            historyTool: true,
            budgetBytes: 16000,
            items: 0,
            omittedItems: 0,
            omitted: [],
            constraints: 0,
            notes: [],
          },
          binding: { providerId: 'claude', throughSeq: -1, strategy: 'x', notes: [] },
        },
      ],
    },
  },
  'session.send': {
    params: {
      valid: [
        { sessionId: ids.session, content: [{ type: 'text', text: '继续' }] },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '继续' }],
          clientMessageId: 'msg-2',
        },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '顺便把测试也跑一下' }],
          clientMessageId: 'msg-3',
          delivery: 'steer',
        },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '这个报错是什么意思' }, imagePart],
          clientMessageId: 'msg-4',
        },
        {
          sessionId: ids.session,
          content: [{ type: 'image', imageId: ids.image, mimeType: 'image/webp', size: 512 }],
        },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '先做个计划' }],
          clientMessageId: 'msg-5',
          collaborationMode: 'plan',
        },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '实施这个计划' }],
          delivery: 'queue',
          collaborationMode: 'default',
        },
      ],
      invalid: [
        { sessionId: ids.session, content: [] },
        { sessionId: ids.session, content: [{ type: 'image', data: 'xx' }] },
        { sessionId: ids.session, content: [{ ...imagePart, mimeType: 'image/tiff' }] },
        { sessionId: ids.session, content: [{ ...imagePart, imageId: 'img-1' }] },
        { sessionId: ids.session, content: [{ type: 'text', text: 'x' }], clientMessageId: '' },
        { sessionId: ids.session, content: [{ type: 'text', text: 'x' }], delivery: 'now' },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: 'x' }],
          collaborationMode: 'review',
        },
      ],
    },
    result: {
      valid: [
        { turnId: ids.turn, seq: 13 },
        { pendingId: ids.pending, seq: 14 },
      ],
      invalid: [
        { turnId: ids.turn, seq: 0 },
        { pendingId: ids.turn, seq: 14 },
      ],
    },
  },
  'session.cancel': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{ sessionId: 'ses-1' }] },
    result: empty,
  },
  'session.close': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{ sessionId: 42 }] },
    result: empty,
  },
  'session.resume': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: { valid: [{ session }], invalid: [{}] },
  },
  'session.rewind': {
    params: {
      valid: [{ sessionId: ids.session, turnId: ids.turn }],
      invalid: [{ sessionId: ids.session }],
    },
    result: { valid: [{ seq: 12 }], invalid: [{}] },
  },
  'session.undo': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, turnId: ids.turn }],
      invalid: [{}, { sessionId: ids.session, turnId: 'turn-1' }],
    },
    result: {
      valid: [
        { seq: 14, turnId: ids.turn, files: { status: 'restored', fileCount: 2 } },
        { seq: 14, turnId: ids.turn, files: { status: 'unavailable', reason: 'head_moved' } },
      ],
      invalid: [
        { seq: 14, turnId: ids.turn },
        { seq: 14, files: { status: 'restored' } },
      ],
    },
  },
  'session.redo': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, turnId: ids.turn }],
      invalid: [{}],
    },
    result: {
      valid: [{ seq: 15, turnId: ids.turn, files: { status: 'unchanged' } }],
      invalid: [{ seq: 15 }],
    },
  },
  'session.recap': {
    params: {
      valid: [
        { sessionId: ids.session, seenSeq: 12, awayMs: 600_000 },
        { sessionId: ids.session, seenSeq: 0, awayMs: 0 },
      ],
      invalid: [
        {},
        { sessionId: ids.session, seenSeq: 12 },
        { sessionId: ids.session, seenSeq: -1, awayMs: 1000 },
        { sessionId: ids.session, seenSeq: 12, awayMs: -5 },
        { sessionId: ids.session, seenSeq: 12, awayMs: 1.5 },
      ],
    },
    result: {
      valid: [
        {
          recap: {
            text: '在修复登录接口的 500 错误。请在本地登录一次，确认不再报错。',
            generatedAt: '2026-10-18T09:30:00.000Z',
            throughSeq: 41,
          },
        },
        { reason: 'running' },
        {},
      ],
      invalid: [
        { recap: { text: '', generatedAt: '2026-10-18T09:30:00.000Z', throughSeq: 41 } },
        { recap: { text: '摘要', generatedAt: 'yesterday', throughSeq: 41 } },
        { recap: { text: '摘要', generatedAt: '2026-10-18T09:30:00.000Z', throughSeq: 0 } },
        { reason: '' },
      ],
    },
  },
  'session.fork': {
    params: {
      valid: [
        { sessionId: ids.session, side: true },
        { sessionId: ids.session },
        { sessionId: ids.session, turnId: ids.turn },
      ],
      invalid: [
        { sessionId: ids.session, side: false },
        { sessionId: ids.session, turnId: 'turn-1' },
      ],
    },
    result: {
      valid: [{ session: sideSession }, { session: branchSession }],
      invalid: [{ session: { ...sideSession, side: false } }],
    },
  },
  'session.setGoal': {
    params: {
      valid: [
        { sessionId: ids.session, objective: '把登录页的测试补齐并全部通过' },
        { sessionId: ids.session, objective: '迁移到新的构建脚本', tokenBudget: 200000 },
      ],
      invalid: [
        { sessionId: ids.session, objective: '  ' },
        { sessionId: ids.session, objective: 'x'.repeat(4001) },
        { sessionId: ids.session, objective: '迁移', tokenBudget: 0 },
      ],
    },
    result: {
      valid: [{ turnId: ids.turn, seq: 12 }],
      invalid: [{ turnId: ids.session, seq: 12 }],
    },
  },
  'session.updateGoal': {
    params: {
      valid: [
        { sessionId: ids.session, status: 'paused' },
        { sessionId: ids.session, status: 'active' },
      ],
      invalid: [{ sessionId: ids.session, status: 'complete' }, { sessionId: ids.session }],
    },
    result: {
      valid: [{ goal: { ...sessionGoal, status: 'paused' } }],
      invalid: [{ goal: null }],
    },
  },
  'session.clearGoal': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: { valid: [{ cleared: true }, { cleared: false }], invalid: [{}] },
  },
  'session.compact': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}, { sessionId: ids.turn }] },
    result: {
      valid: [{ turnId: ids.turn, seq: 12 }],
      invalid: [{ turnId: ids.turn }, { seq: 12 }],
    },
  },
  'session.review': {
    params: {
      valid: [
        { sessionId: ids.session, target: 'uncommitted' },
        { sessionId: ids.session, target: 'branch' },
      ],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, target: 'commit' }],
    },
    result: {
      valid: [{ turnId: ids.turn, seq: 12 }],
      invalid: [{ turnId: ids.session, seq: 12 }],
    },
  },
  'session.rename': {
    params: {
      valid: [{ sessionId: ids.session, title: '修复登录' }],
      invalid: [
        { sessionId: ids.session, title: '' },
        { sessionId: ids.session, title: 'x'.repeat(201) },
        { sessionId: ids.session },
      ],
    },
    result: {
      valid: [{ session: { ...session, title: '修复登录', titleSource: 'user' } }],
      invalid: [{ session: { ...session, titleSource: 'renamed' } }],
    },
  },
  'session.delete': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, force: true }],
      invalid: [{}, { sessionId: ids.session, force: 'yes' }],
    },
    result: {
      valid: [
        { sessionIds: [ids.session] },
        {
          sessionIds: [ids.session, ids.childSession],
          keptBranches: ['wevir/fix-login'],
          engineDataKept: true,
        },
      ],
      invalid: [{}, { sessionIds: [ids.session], engineDataKept: false }],
    },
  },
  'session.usage': {
    params: { valid: [{}, { archived: true }], invalid: [{ archived: 'yes' }] },
    result: {
      valid: [
        { sessions: [] },
        {
          sessions: [
            { sessionId: ids.session, eventBytes: 48_213, fileBytes: 0, worktrees: [] },
            {
              sessionId: ids.childSession,
              eventBytes: 1_024,
              fileBytes: 2_048,
              worktrees: [
                {
                  workspaceId: ids.workspace,
                  branch: 'wevir/fix-login',
                  path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-app',
                  bytes: 1_048_576,
                  dirty: true,
                },
                {
                  workspaceId: ids.workspace,
                  branch: 'wevir/fix-login-2',
                  path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/2-lib',
                  bytes: 0,
                  dirty: false,
                  missing: true,
                },
              ],
            },
          ],
        },
      ],
      invalid: [
        {},
        { sessions: [{ sessionId: ids.session, eventBytes: -1, fileBytes: 0, worktrees: [] }] },
      ],
    },
  },
  'session.archive': {
    params: {
      valid: [
        { sessionId: ids.session, archived: true },
        { sessionId: ids.session, archived: false },
      ],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, archived: 'yes' }],
    },
    result: {
      valid: [
        { session: { ...session, state: 'closed', archivedAt: TS2 } },
        { session: { ...session, state: 'closed' } },
      ],
      invalid: [{ session: { ...session, archivedAt: 1 } }],
    },
  },
  'session.checkpoints': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}, { sessionId: ids.workspace }] },
    result: {
      valid: [
        { repo: false, turns: [] },
        {
          repo: true,
          turns: [
            { turnId: ids.turn, fileCount: 2, added: 10, removed: 3 },
            { turnId: ids.childTurn },
          ],
        },
      ],
      invalid: [{ repo: true }, { repo: true, turns: [{ turnId: ids.session }] }],
    },
  },
  'search.query': {
    params: {
      valid: [
        { query: 'event-store.ts' },
        {
          query: '登录 "审批 流程"',
          scope: {
            workspaceIds: [ids.workspace],
            sessionIds: [ids.session],
            kinds: ['user_message', 'command'],
            providerIds: ['deepseek-official'],
            since: TS,
            until: TS2,
            includeArchived: true,
          },
          sort: 'recent',
          limit: 20,
          offset: 20,
        },
      ],
      invalid: [{ query: '' }, { query: 'x', limit: 0 }, { query: 'x', sort: 'oldest' }],
    },
    result: {
      valid: [
        { hits: [searchHit], nextOffset: 20, mode: 'index', index: searchIndexStatus },
        {
          hits: [{ ...searchHit, kind: 'command', archived: true, highlights: [] }],
          nextOffset: null,
          mode: 'scan',
          reason: 'short_query',
          scan: { examined: 20000, limit: 20000, complete: false },
          index: { state: 'indexing', fts: true, pendingSessions: 3, pendingEvents: 1200 },
        },
      ],
      invalid: [
        { hits: [], nextOffset: null, mode: 'fuzzy', index: searchIndexStatus },
        {
          hits: [{ ...searchHit, seq: 0 }],
          nextOffset: null,
          mode: 'index',
          index: searchIndexStatus,
        },
      ],
    },
  },
  'search.status': {
    params: empty,
    result: {
      valid: [
        searchIndexStatus,
        { state: 'indexing', fts: false, pendingSessions: 1, pendingEvents: 5 },
      ],
      invalid: [{ ...searchIndexStatus, state: 'stale' }, { state: 'ready' }],
    },
  },
  'search.rebuild': {
    params: empty,
    result: {
      valid: [{ state: 'indexing', fts: true, pendingSessions: 300, pendingEvents: 200000 }],
      invalid: [{}],
    },
  },
  'pending.update': {
    params: {
      valid: [
        {
          sessionId: ids.session,
          pendingId: ids.pending2,
          content: [{ type: 'text', text: '改' }],
        },
        { sessionId: ids.session, pendingId: ids.pending2, delivery: 'steer' },
      ],
      invalid: [
        { sessionId: ids.session, pendingId: ids.pending2, content: [] },
        { sessionId: ids.session, pendingId: ids.turn },
      ],
    },
    result: { valid: [{ pending: pendingHeld }], invalid: [{ pending: { id: ids.pending } }] },
  },
  'image.upload': {
    params: {
      valid: [
        { mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'screenshot.png' },
        { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
      ],
      invalid: [
        { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        { mimeType: 'image/png', data: '' },
        { mimeType: 'image/png', data: 'x'.repeat(IMAGE_UPLOAD_DATA_MAX_LENGTH + 1) },
      ],
    },
    result: {
      valid: [{ image: imagePart }],
      invalid: [{ image: { ...imagePart, size: 0 } }],
    },
  },
  'web.get': {
    params: empty,
    result: {
      valid: [
        {
          web: {
            enabled: true,
            searchService: 'bocha',
            services: [
              { id: 'bocha', hasKey: true },
              { id: 'tavily', hasKey: false },
            ],
          },
        },
      ],
      invalid: [{ web: { enabled: true, searchService: 'Bocha!', services: [] } }, {}],
    },
  },
  'web.update': {
    params: {
      valid: [
        { enabled: false },
        { searchService: 'tavily' },
        { key: { service: 'bocha', apiKey: 'sk-test-not-a-secret' } },
        { key: { service: 'tavily', apiKey: null } },
        {},
      ],
      invalid: [{ key: { service: 'bocha', apiKey: '' } }, { enabled: 'yes' }],
    },
    result: {
      valid: [
        {
          web: {
            enabled: false,
            searchService: 'tavily',
            services: [
              { id: 'bocha', hasKey: false },
              { id: 'tavily', hasKey: true },
            ],
          },
        },
      ],
      invalid: [{ web: { enabled: false } }],
    },
  },
  'web.test': {
    params: {
      valid: [{}, { service: 'tavily' }, { service: 'bocha', apiKey: 'sk-test-not-a-secret' }],
      invalid: [{ apiKey: '' }, { service: '' }],
    },
    result: {
      valid: [
        { ok: true, service: 'bocha', latencyMs: 812, results: 3 },
        {
          ok: false,
          service: 'tavily',
          latencyMs: 230,
          reason: 'auth',
          httpStatus: 401,
          message: 'Unauthorized: missing or invalid API key.',
        },
        { ok: false, service: 'bocha', reason: 'missing_key' },
      ],
      invalid: [{ ok: true }, { ok: false, service: 'bocha', reason: 'expired' }],
    },
  },
  'image.read': {
    params: {
      valid: [{ imageId: ids.image }, { imageId: ids.image, offset: 4194304 }],
      invalid: [{ imageId: ids.turn }, { imageId: ids.image, offset: -1 }],
    },
    result: {
      valid: [
        { imageId: ids.image, mimeType: 'image/png', size: 48213, offset: 0, data: 'iVBORw0KGgo=' },
      ],
      invalid: [{ imageId: ids.image, mimeType: 'image/png', size: 48213, data: '' }],
    },
  },
  'pending.cancel': {
    params: {
      valid: [{ sessionId: ids.session, pendingId: ids.pending2 }],
      invalid: [{ sessionId: ids.session }],
    },
    result: {
      valid: [{ pending: { ...pendingHeld, status: 'cancelled' } }],
      invalid: [{ pending: { ...pendingHeld, status: 'deleted' } }],
    },
  },
  'pending.resume': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{ pendingId: ids.pending }] },
    result: {
      valid: [{ pendingMessages: [] }, { pendingMessages: [pendingSteer, pendingHeld] }],
      invalid: [{}],
    },
  },
  'memory.list': {
    params: {
      valid: [{}, { workspaceId: ids.workspace }],
      invalid: [{ workspaceId: 'x' }],
    },
    result: {
      valid: [
        { notes: [], unreadable: [] },
        {
          notes: [
            memorySummary,
            {
              ...memorySummary,
              scope: 'global',
              name: 'reply-language',
              type: 'user',
              enabled: false,
            },
          ],
          unreadable: [{ scope: 'project', name: 'broken-note' }],
        },
        { notes: [{ ...memorySummary, updatedAt: '' }], unreadable: [] },
        {
          notes: [
            {
              ...memorySummary,
              origin: { by: 'agent', at: TS, sessionId: ids.session, seq: 3 },
              lastEdit: { by: 'agent', at: '', sessionId: ids.childSession },
            },
          ],
          unreadable: [],
        },
      ],
      invalid: [
        { notes: [] },
        { notes: [{ ...memorySummary, origin: { at: TS } }], unreadable: [] },
        { notes: [{ ...memorySummary, origin: { by: 'model', at: TS } }], unreadable: [] },
        {
          notes: [{ ...memorySummary, origin: { by: 'agent', at: TS, sessionId: 'abc' } }],
          unreadable: [],
        },
        { notes: [{ ...memorySummary, type: 'secret' }], unreadable: [] },
        { notes: [{ ...memorySummary, name: 'Bad Name' }], unreadable: [] },
        { notes: [{ ...memorySummary, revision: '' }], unreadable: [] },
      ],
    },
  },
  'memory.read': {
    params: {
      valid: [
        { scope: 'project', workspaceId: ids.workspace, name: 'invoice-cents' },
        { scope: 'global', name: 'reply-language' },
      ],
      invalid: [{ scope: 'team', name: 'x' }, { scope: 'global', name: '-x' }, { scope: 'global' }],
    },
    result: {
      valid: [
        { note: memoryNote },
        {
          note: {
            ...memorySourced,
            origin: { ...(memorySourced.origin as MemorySource), status: 'withdrawn' },
          },
        },
        {
          note: {
            ...memorySourced,
            origin: { ...(memorySourced.origin as MemorySource), status: 'deleted' },
            lastEdit: { by: 'agent', at: TS, sessionId: ids.childSession, status: 'available' },
          },
        },
      ],
      invalid: [
        { note: memorySummary },
        {},
        {
          note: {
            ...memorySourced,
            origin: { ...(memorySourced.origin as MemorySource), status: 'gone' },
          },
        },
        { note: { ...memorySourced, lastEdit: { by: 'user', at: TS, seq: 0 } } },
      ],
    },
  },
  'memory.update': {
    params: {
      valid: [
        {
          scope: 'project',
          workspaceId: ids.workspace,
          name: 'invoice-cents',
          revision: memorySummary.revision,
          description: 'Discounts use integer cents',
          content: 'Round once, at the end.',
        },
        { scope: 'global', name: 'reply-language', revision: 'r2', type: 'feedback' },
      ],
      invalid: [
        { scope: 'global', name: 'reply-language' },
        { scope: 'global', name: 'reply-language', revision: '' },
        { scope: 'global', name: 'reply-language', revision: 'r2', type: 'secret' },
      ],
    },
    result: {
      valid: [{ note: memoryNote }, { note: memoryNote, conflict: true }, { note: memorySourced }],
      invalid: [{ note: memoryNote, conflict: false }, {}],
    },
  },
  'memory.setEnabled': {
    params: {
      valid: [
        { scope: 'project', workspaceId: ids.workspace, name: 'invoice-cents', enabled: false },
        { scope: 'global', name: 'reply-language', enabled: true },
      ],
      invalid: [
        { scope: 'global', name: 'reply-language' },
        { scope: 'global', name: 'x', enabled: 'no' },
      ],
    },
    result: {
      valid: [{ note: { ...memoryNote, enabled: false } }],
      invalid: [{}],
    },
  },
  'memory.delete': {
    params: {
      valid: [
        { scope: 'project', workspaceId: ids.workspace, name: 'invoice-cents', revision: 'r1' },
        { scope: 'project', workspaceId: ids.workspace, name: 'broken-note' },
      ],
      invalid: [
        { scope: 'project', name: 'Broken' },
        { scope: 'global', name: 'x', revision: '' },
      ],
    },
    result: {
      valid: [{}, { conflict: true, note: memoryNote }],
      invalid: [{ conflict: false }],
    },
  },
  'usage.summary': {
    params: {
      valid: [
        { edges: [1_760_918_400_000, 1_761_004_800_000] },
        {
          edges: [1_760_918_400_000, 1_760_922_000_000, 1_760_925_600_000],
          filter: { sources: ['claude', 'chatgpt'], providerIds: ['prv_1'], models: [] },
        },
      ],
      invalid: [
        {},
        { edges: [1] },
        { edges: [-1, 2] },
        { edges: [1, 2], filter: { sources: ['nope'] } },
      ],
    },
    result: {
      valid: [
        {
          totals: usageAggregate,
          buckets: [usageAggregate, { ...usageAggregate, requests: 0 }],
          byProvider: [
            {
              ...usageAggregate,
              providerId: 'prv_claude',
              providerName: 'Claude',
              source: 'claude',
            },
          ],
          byModel: [{ ...usageAggregate, model: 'claude-opus-5-5' }],
          options: {
            sources: ['claude'],
            providers: [{ id: 'prv_claude', name: 'Claude', source: 'claude' }],
            models: ['claude-opus-5-5'],
          },
          pricing: {
            source: 'models.dev',
            fetchedAt: 1_760_918_400_000,
            models: 4_210,
            refreshing: false,
          },
        },
      ],
      invalid: [{ totals: usageAggregate }],
    },
  },
  'usage.records': {
    params: {
      valid: [
        { from: 0, to: 1_761_004_800_000 },
        { from: 0, to: 1, filter: { models: ['gpt-5.5'] }, offset: 50, limit: 50 },
      ],
      invalid: [{ from: 0 }, { from: 0, to: 1, limit: 0 }],
    },
    result: {
      valid: [
        { records: [], total: 0 },
        {
          records: [
            {
              id: '42',
              at: 1_760_937_254_000,
              sessionId: ids.session,
              requestId: 'msg_011CgCXLLe7JJph3wyFYBkJD',
              source: 'claude',
              providerId: 'prv_claude',
              providerName: 'Claude',
              model: 'claude-opus-5-5',
              tokens: { input: 2, output: 159, cacheRead: 225_678, cacheWrite: 697, reasoning: 0 },
              cost: {
                input: 0.00001,
                output: 0.0032,
                cacheRead: 0.0451,
                cacheWrite: 0.0056,
                total: 0.0539,
              },
              price: { input: 5, output: 20, cacheRead: 0.2, cacheWrite: 8 },
              priceSource: 'anthropic',
              durationMs: 2_800,
              firstTokenMs: 1_400,
            },
            {
              id: '43',
              at: 1_760_937_255_000,
              sessionId: 'ses_deleted',
              requestId: 'msg_c2f1',
              source: 'opencode',
              providerId: 'prv_opencode',
              providerName: 'OpenCode',
              upstream: 'github-copilot',
              model: 'gpt-5.5',
              tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5 },
            },
          ],
          total: 2,
        },
      ],
      invalid: [{ records: [{ id: '1' }], total: 1 }],
    },
  },
  'usage.pricing': {
    params: { valid: [{}, { refresh: true }], invalid: [{ refresh: 'yes' }] },
    result: {
      valid: [
        { pricing: { source: 'models.dev', models: 0, refreshing: true } },
        {
          pricing: {
            source: 'models.dev',
            fetchedAt: 1_760_918_400_000,
            models: 4_210,
            refreshing: false,
            lastError: 'HTTP 503',
          },
        },
      ],
      invalid: [{ pricing: { source: 'models.dev' } }],
    },
  },
  'checks.list': {
    params: { valid: [{ workspaceId: ids.workspace }], invalid: [{}, { workspaceId: 'x' }] },
    result: {
      valid: [
        {
          checks: [checkDefinition],
          repair: {
            enabled: false,
            maxAttempts: 2,
            maxDurationMs: 1_200_000,
            maxTokens: 1_000_000,
          },
        },
      ],
      invalid: [{ checks: [] }],
    },
  },
  'checks.candidates': {
    params: { valid: [{ workspaceId: ids.workspace }], invalid: [{}] },
    result: {
      valid: [
        {
          candidates: [
            {
              name: 'test',
              command: 'pnpm run test',
              cwd: '',
              kind: 'test',
              source: {
                kind: 'package_script',
                file: 'package.json',
                script: 'test',
                body: 'vitest run',
              },
            },
            {
              name: 'pnpm typecheck',
              command: 'pnpm typecheck',
              cwd: '',
              kind: 'typecheck',
              source: { kind: 'instructions', file: 'AGENTS.md', line: 78 },
            },
          ],
        },
        { candidates: [] },
      ],
      invalid: [{ candidates: [{ name: 'x' }] }],
    },
  },
  'checks.save': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          check: { name: 'test', command: 'npm test', kind: 'test', trigger: 'manual' },
        },
        {
          workspaceId: ids.workspace,
          check: {
            id: ids.check,
            name: 'test',
            command: 'pnpm run test',
            cwd: 'packages/host',
            timeoutMs: 120_000,
            kind: 'test',
            trigger: 'after_turn',
            paths: ['src/'],
            expectOutput: 'Tests\\s+\\d+ passed',
            source: { kind: 'package_script', file: 'packages/host/package.json', script: 'test' },
          },
        },
      ],
      invalid: [
        {
          workspaceId: ids.workspace,
          check: { name: '', command: 'x', kind: 'test', trigger: 'manual' },
        },
        {
          workspaceId: ids.workspace,
          check: { name: 'x', command: 'x', kind: 'test', trigger: 'manual', timeoutMs: 10 },
        },
      ],
    },
    result: { valid: [{ check: checkDefinition }], invalid: [{ check: { id: ids.check } }] },
  },
  'checks.remove': {
    params: {
      valid: [{ workspaceId: ids.workspace, checkId: ids.check }],
      invalid: [{ workspaceId: ids.workspace }],
    },
    result: { valid: [{ removed: true }, { removed: false }], invalid: [{}] },
  },
  'checks.setRepair': {
    params: {
      valid: [
        { workspaceId: ids.workspace, repair: { enabled: true } },
        { workspaceId: ids.workspace, repair: { maxAttempts: 3, maxDurationMs: 600_000 } },
      ],
      invalid: [{ workspaceId: ids.workspace, repair: { maxAttempts: 9 } }],
    },
    result: {
      valid: [
        {
          repair: { enabled: true, maxAttempts: 2, maxDurationMs: 1_200_000, maxTokens: 1_000_000 },
        },
      ],
      invalid: [{ repair: { enabled: true } }],
    },
  },
  'verification.run': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, checkIds: [ids.check] }],
      invalid: [{ sessionId: ids.session, checkIds: [] }],
    },
    result: {
      valid: [
        {
          roundId: ids.verificationRound,
          runs: [{ ...verificationRun, trigger: 'manual', status: 'running', reason: undefined }],
        },
      ],
      invalid: [{ runs: [] }],
    },
  },
  'verification.cancel': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: { valid: [{ cancelled: 0 }, { cancelled: 2 }], invalid: [{ cancelled: -1 }] },
  },
  'verification.status': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: {
      valid: [
        {
          verification: { acceptance, runs: [verificationRun], repair: repairChain },
          codeState: { kind: 'git', head: null, tree: '9d8e7f6a' },
        },
        {
          verification: { acceptance: { status: 'unverified', updatedAt: TS }, runs: [] },
          codeState: { kind: 'none', reason: 'not_git' },
        },
      ],
      invalid: [{ verification: { runs: [] } }],
    },
  },
  'verification.output': {
    params: {
      valid: [
        { sessionId: ids.session, runId: ids.verificationRun },
        { sessionId: ids.session, runId: ids.verificationRun, offset: 4096 },
      ],
      invalid: [{ sessionId: ids.session, runId: ids.verificationRun, offset: -1 }],
    },
    result: {
      valid: [{ text: 'not ok 4\n', from: 0, next: 9, more: false, bytes: 9 }],
      invalid: [{ text: '' }],
    },
  },
  'review.list': {
    params: {
      valid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, sessionId: ids.session, status: 'pending' },
      ],
      invalid: [{}, { workspaceId: ids.workspace, status: 'draft' }],
    },
    result: {
      valid: [{ comments: [] }, { comments: [reviewComment, sentReviewComment] }],
      invalid: [{}, { comments: [{ ...reviewComment, side: 'left' }] }],
    },
  },
  'review.add': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          source: { kind: 'uncommitted' },
          base: SHA1,
          path: 'src/convert.ts',
          side: 'new',
          startLine: 12,
          endLine: 14,
          body: '负数要四舍五入',
        },
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          source: { kind: 'turn', turnId: ids.turn },
          base: SHA1,
          head: SHA2,
          path: 'src/b.ts',
          previousPath: 'src/a.ts',
          side: 'old',
          startLine: 3,
          endLine: 3,
          body: '为什么删掉',
        },
      ],
      invalid: [
        {
          workspaceId: ids.workspace,
          source: { kind: 'uncommitted' },
          base: 'HEAD',
          path: 'a.ts',
          side: 'new',
          startLine: 1,
          endLine: 1,
          body: 'x',
        },
        {
          workspaceId: ids.workspace,
          source: { kind: 'uncommitted' },
          base: SHA1,
          path: 'a.ts',
          side: 'new',
          startLine: 0,
          endLine: 1,
          body: 'x',
        },
      ],
    },
    result: {
      valid: [{ comment: reviewComment }],
      invalid: [{}, { comment: { ...reviewComment, anchor: { state: 'moved' } } }],
    },
  },
  'review.update': {
    params: {
      valid: [{ commentId: ids.reviewComment, body: '改成向下取整' }],
      invalid: [{ commentId: ids.reviewComment, body: '   ' }, { body: 'x' }],
    },
    result: { valid: [{ comment: reviewComment }], invalid: [{}] },
  },
  'review.remove': {
    params: {
      valid: [{ commentIds: [ids.reviewComment, ids.reviewComment2] }],
      invalid: [{ commentIds: [] }, { commentIds: [ids.session] }],
    },
    result: { valid: [{ removed: 2 }, { removed: 0 }], invalid: [{ removed: -1 }] },
  },
  'review.send': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          commentIds: [ids.reviewComment],
          targetSessionId: ids.session,
        },
        {
          workspaceId: ids.workspace,
          commentIds: [ids.reviewComment, ids.reviewComment2],
          targetSessionId: ids.childSession,
          delivery: 'queue',
          clientMessageId: 'review-1',
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, commentIds: [], targetSessionId: ids.session },
        { workspaceId: ids.workspace, commentIds: [ids.reviewComment] },
      ],
    },
    result: {
      valid: [
        { comments: [{ ...reviewComment, status: 'sent' }], turnId: ids.turn, seq: 12 },
        { comments: [], pendingId: ids.pending, seq: 13 },
      ],
      invalid: [{ comments: [] }],
    },
  },
  'git.status': {
    params: {
      valid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, sessionId: ids.session },
      ],
      invalid: [{}, { workspaceId: ids.session }],
    },
    result: {
      valid: [{ repo: false }, gitStatusSample, gitStatusUnborn],
      invalid: [
        { ...gitStatusSample, index: 'HEAD' },
        { ...gitStatusSample, files: [{ path: 'a.ts', staged: { status: 'modified' } }] },
      ],
    },
  },
  'git.stage': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          paths: ['src/convert.ts', 'docs/notes.md'],
          expected: { head: SHA1, index: INDEX_TOKEN },
        },
        {
          workspaceId: ids.workspace,
          paths: ['a.ts'],
          expected: { head: null, index: INDEX_TOKEN },
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, paths: [], expected: { head: SHA1, index: INDEX_TOKEN } },
        { workspaceId: ids.workspace, paths: ['a.ts'] },
        { workspaceId: ids.workspace, paths: ['a.ts'], expected: { head: SHA1, index: 'x' } },
      ],
    },
    result: { valid: [{ status: gitStatusSample }], invalid: [{}] },
  },
  'git.unstage': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          paths: ['docs/notes.md'],
          expected: { head: SHA1, index: INDEX_TOKEN },
        },
      ],
      invalid: [{ workspaceId: ids.workspace, paths: ['a.ts'], expected: { index: INDEX_TOKEN } }],
    },
    result: { valid: [{ status: gitStatusSample }], invalid: [{ status: { repo: 'yes' } }] },
  },
  'git.commit': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          message: 'Round negative temperatures',
          expected: { head: SHA1, index: INDEX_TOKEN },
        },
        {
          workspaceId: ids.workspace,
          message: 'Initial commit',
          expected: { head: null, index: INDEX_TOKEN },
          includeExternal: true,
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, message: '', expected: { head: SHA1, index: INDEX_TOKEN } },
        { workspaceId: ids.workspace, message: 'x' },
      ],
    },
    result: {
      valid: [
        {
          outcome: {
            kind: 'committed',
            commit: SHA2,
            parent: SHA1,
            tree: GIT_TREE,
            stagedTree: GIT_TREE,
            hooks: ['pre-commit', 'commit-msg'],
          },
          status: { ...gitStatusSample, head: SHA2, files: [], fileCount: 0 },
        },
        {
          outcome: {
            kind: 'failed',
            reason: 'hook_failed',
            hook: 'pre-commit',
            exitCode: 1,
            output: 'lint failed: src/convert.ts',
          },
          status: gitStatusSample,
        },
        { outcome: { kind: 'failed', reason: 'external_staged' }, status: gitStatusSample },
      ],
      invalid: [
        { outcome: { kind: 'committed', commit: SHA2 }, status: gitStatusSample },
        { outcome: { kind: 'failed', reason: '' }, status: gitStatusSample },
      ],
    },
  },
  'process.list': {
    params: {
      valid: [{}, { workspaceId: ids.workspace }, { sessionId: ids.session }],
      invalid: [{ workspaceId: ids.session }],
    },
    result: {
      valid: [{ processes: [] }, { processes: [agentProcess, checkProcess] }],
      invalid: [{}, { processes: [{ ...agentProcess, id: 'proc-1' }] }],
    },
  },
  'process.output': {
    params: {
      valid: [{ processId: 'p3' }, { processId: 'p3', offset: 4096, until: 8192 }],
      invalid: [{}, { processId: 'p3', offset: -1 }],
    },
    result: {
      valid: [{ text: 'ready on :5173\n', from: 0, next: 15, start: 0, bytes: 15, more: false }],
      invalid: [{ text: '' }],
    },
  },
  'process.stop': {
    params: {
      valid: [{ processId: 'p3' }, { processId: 'p3', signal: 'SIGINT' }],
      invalid: [{ processId: 'p3', signal: 'SIGHUP' }],
    },
    result: {
      valid: [{ process: checkProcess }],
      invalid: [{ process: { ...checkProcess, stoppedBy: 'someone' } }],
    },
  },
  'terminal.create': {
    params: {
      valid: [
        { workspaceId: ids.workspace, cols: 80, rows: 24 },
        { workspaceId: ids.workspace, sessionId: ids.session, cwd: '/tmp', cols: 120, rows: 32 },
      ],
      invalid: [{ workspaceId: ids.workspace }, { workspaceId: ids.workspace, cols: 0, rows: 24 }],
    },
    result: {
      valid: [{ terminal: terminalSample }],
      invalid: [{ terminal: { ...terminalSample, id: 'p3' } }],
    },
  },
  'terminal.list': {
    params: {
      valid: [{}, { workspaceId: ids.workspace }, { sessionId: ids.session }],
      invalid: [{ workspaceId: ids.session }],
    },
    result: {
      valid: [{ terminals: [] }, { terminals: [terminalSample, exitedTerminal] }],
      invalid: [{}, { terminals: [{ ...terminalSample, status: 'stopped' }] }],
    },
  },
  'terminal.attach': {
    params: {
      valid: [{ terminalId: terminalSample.id }, { terminalId: terminalSample.id, since: 4096 }],
      invalid: [{}, { terminalId: terminalSample.id, since: -1 }],
    },
    result: {
      valid: [
        { terminal: terminalSample, reset: false, data: 'ls\r\n', next: 4100 },
        { terminal: terminalSample, reset: true, data: '\u001b[?1049h', next: 9000 },
      ],
      invalid: [{ terminal: terminalSample, data: '', next: 0 }],
    },
  },
  'terminal.detach': {
    params: { valid: [{ terminalId: terminalSample.id }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'terminal.input': {
    params: {
      valid: [{ terminalId: terminalSample.id, data: '\u0003' }],
      invalid: [{ terminalId: terminalSample.id, data: '' }],
    },
    result: { valid: [{}], invalid: [null] },
  },
  'terminal.resize': {
    params: {
      valid: [{ terminalId: terminalSample.id, cols: 100, rows: 30 }],
      invalid: [{ terminalId: terminalSample.id, cols: 100, rows: 0 }],
    },
    result: { valid: [{}], invalid: [null] },
  },
  'terminal.close': {
    params: { valid: [{ terminalId: terminalSample.id }], invalid: [{ terminalId: 'p3' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'automation.list': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [{ automations: [] }, { automations: [automationSample] }],
      invalid: [{}, { automations: [{ ...automationSample, runCount: -1 }] }],
    },
  },
  'automation.get': {
    params: {
      valid: [{ automationId: ids.automation }],
      invalid: [{}, { automationId: ids.session }],
    },
    result: {
      valid: [
        { automation: automationSample, runs: [] },
        { automation: automationSample, runs: [automationRunSample, automationRunFailedSample] },
      ],
      invalid: [{ automation: automationSample }],
    },
  },
  'automation.create': {
    params: {
      valid: [
        {
          title: '依赖更新检查',
          prompt: '检查过期的依赖与安全公告。',
          schedule: { kind: 'daily', time: '09:00', weekdays: [1] },
          providerId: 'deepseek',
        },
        {
          title: '提醒',
          prompt: '提醒发周报。',
          schedule: { kind: 'once', at: '2026-10-23T09:00:00.000Z' },
          timezone: 'Pacific/Auckland',
          enabled: false,
          workspaceId: ids.workspace,
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          reasoningEffort: 'high',
          permissionMode: 'auto_review',
          newSessionEachRun: false,
          notify: 'failures',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'monthly', time: '23:59', day: 31 },
          providerId: 'deepseek',
        },
      ],
      invalid: [
        { title: '', prompt: 'y', schedule: { kind: 'manual' }, providerId: 'deepseek' },
        { title: 'x', prompt: '  ', schedule: { kind: 'manual' }, providerId: 'deepseek' },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'interval', minutes: 1 },
          providerId: 'deepseek',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'daily', time: '9:00' },
          providerId: 'deepseek',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'daily', time: '09:00', weekdays: [7] },
          providerId: 'deepseek',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'daily', time: '09:00', weekdays: [] },
          providerId: 'deepseek',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'monthly', time: '09:00', day: 0 },
          providerId: 'deepseek',
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'cron', expr: '* * * * *' },
          providerId: 'deepseek',
        },
        { title: 'x', prompt: 'y', schedule: { kind: 'manual' } },
      ],
    },
    result: {
      valid: [{ automation: automationSample }],
      invalid: [{}],
    },
  },
  'automation.update': {
    params: {
      valid: [
        { automationId: ids.automation },
        { automationId: ids.automation, enabled: false },
        { automationId: ids.automation, workspaceId: null, modelId: null, reasoningEffort: null },
        {
          automationId: ids.automation,
          schedule: { kind: 'interval', minutes: 60 },
          timezone: 'Asia/Shanghai',
          notify: 'never',
        },
      ],
      invalid: [
        {},
        { automationId: ids.automation, title: '' },
        { automationId: ids.automation, permissionMode: 'yolo' },
      ],
    },
    result: { valid: [{ automation: automationSample }], invalid: [{ automation: {} }] },
  },
  'automation.delete': {
    params: { valid: [{ automationId: ids.automation }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'automation.run': {
    params: { valid: [{ automationId: ids.automation }], invalid: [{ automationId: 'aut_' }] },
    result: {
      valid: [{ run: automationRunSample }, { run: automationRunFailedSample }],
      invalid: [{ run: { ...automationRunSample, status: 'done' } }],
    },
  },
  'tools.presets': {
    params: empty,
    result: {
      valid: [
        {
          presets: [
            {
              id: 'full',
              groups: [
                'sessions',
                'catalog',
                'tasks',
                'memory',
                'workbench',
                'browser',
                'lsp',
                'processes',
                'plugins',
              ],
            },
            { id: 'core', groups: ['sessions', 'catalog', 'tasks', 'memory', 'workbench'] },
          ],
          groups: [
            { id: 'sessions', tools: ['wevir_session_list', 'wevir_session_read'] },
            { id: 'browser', tools: [] },
          ],
        },
      ],
      invalid: [
        { presets: [{ id: 'minimal', groups: [] }], groups: [] },
        { presets: [], groups: [{ id: 'terminal', tools: [] }] },
      ],
    },
  },
  'question.respond': {
    params: {
      valid: [
        { questionId: ids.question, answers: { scope: { answers: ['全链路'] } } },
        { questionId: ids.question, answers: {} },
      ],
      invalid: [{ answers: {} }, { questionId: ids.question, answers: { scope: ['x'] } }],
    },
    result: {
      valid: [
        {
          questionId: ids.question,
          status: 'answered',
          resolution: { reason: 'user', answers: {}, answeredBy: identity },
        },
      ],
      invalid: [{ questionId: ids.question, status: 'pending' }],
    },
  },
  'approval.respond': {
    params: {
      valid: [{ approvalId: ids.approval, optionId: 'allow-once' }],
      invalid: [{ approvalId: ids.approval }],
    },
    result: {
      valid: [{ approvalId: ids.approval, status: 'approved', resolution: userResolution }],
      invalid: [{ approvalId: ids.approval, status: 'pending', resolution: userResolution }],
    },
  },
  'browser.register': {
    params: {
      valid: [
        { commands: ['list_tabs', 'new_tab', 'snapshot', 'click'] },
        { commands: ['someday'] },
      ],
      invalid: [{ commands: [] }, { commands: [''] }],
    },
    result: empty,
  },
  'browser.unregister': { params: empty, result: empty },
  'browser.respond': {
    params: {
      valid: [
        {
          requestId: ids.browserRequest,
          ok: true,
          result: { command: 'list_tabs', tabs: [browserTab] },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'snapshot',
            browserId: browserTab.browserId,
            url: browserTab.url,
            title: browserTab.title,
            format: 'aria-yaml',
            snapshot: '- button "Save" [ref=@e1]',
            truncated: false,
            stats: { nodeCount: 3, refCount: 1, textLength: 26 },
          },
          dialogs: [
            { type: 'confirm', message: 'Leave?', action: 'dismissed', timestamp: 1760256000000 },
          ],
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: { command: 'click', browserId: browserTab.browserId, ref: '@e1', x: 40, y: 12 },
        },
        {
          requestId: ids.browserRequest,
          ok: false,
          error: {
            code: 'browser_stale_ref',
            message: 'Browser element reference @e3 is stale.',
            retryable: false,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'navigate',
            browserId: browserTab.browserId,
            url: 'http://localhost:5173/missing',
            status: 404,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: false,
          error: {
            code: 'browser_load_failed',
            message:
              'Could not load http://localhost:5173/: ERR_CONNECTION_REFUSED (-102). Nothing accepted the connection: check that the server is running and the port is right.',
            retryable: false,
          },
        },
        // 0.46.0：命令引起的页面变化、分段的快照、带总数与进行中请求的日志、对话框阻塞的错误。
        {
          requestId: ids.browserRequest,
          ok: true,
          result: { command: 'click', browserId: browserTab.browserId, ref: '@e2', x: 10, y: 20 },
          effects: {
            navigation: { url: 'http://localhost:5173/next', status: 200 },
            openedTabs: [{ browserId: 'tab_m2k1_2', url: 'http://localhost:5173/help' }],
            downloads: [
              { url: 'http://localhost:5173/report.csv', filename: 'report.csv', state: 'blocked' },
            ],
            fileChooser: { multiple: false },
          },
          dialogs: [
            { type: 'alert', message: 'Saved', action: 'accepted', timestamp: 1760256000000 },
          ],
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'snapshot',
            browserId: browserTab.browserId,
            url: browserTab.url,
            title: browserTab.title,
            format: 'aria-yaml',
            snapshot:
              '- text: "row 80"\n# Showing lines 81–160 of 6402. Next part: browser_snapshot with offset=160.',
            truncated: true,
            stats: {
              nodeCount: 6405,
              refCount: 2,
              textLength: 90,
              totalLines: 6402,
              startLine: 80,
              shownLines: 80,
            },
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'logs',
            browserId: browserTab.browserId,
            console: [{ level: 'info', message: 'line 999', timestamp: 1760256000000 }],
            network: [
              {
                url: 'http://localhost:5173/api/items',
                method: 'POST',
                type: 'fetch',
                startTime: 12.5,
                duration: 0,
                pending: true,
              },
              {
                url: 'http://localhost:5173/api/old',
                method: 'GET',
                type: 'fetch',
                startTime: 3,
                duration: 4,
                failed: 'net::ERR_ABORTED',
              },
            ],
            consoleTotal: 1000,
            networkTotal: 2,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: false,
          error: {
            code: 'browser_dialog_blocked',
            message: 'A confirm dialog ("Leave?") is blocking browser tab tab_m2k1_1.',
            retryable: false,
          },
          effects: { navigation: { url: 'http://localhost:5173/' } },
        },
        // 0.48.0：执行与查询、网络详情、对话框策略、上传与下载、快照的范围与停在哪里。
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'evaluate',
            browserId: browserTab.browserId,
            value: '{"title":"Wevir"',
            type: 'object',
            truncated: true,
            length: 40,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'query',
            browserId: browserTab.browserId,
            selector: 'a.nav',
            count: 2,
            elements: [
              {
                ref: '@e7',
                tag: 'a',
                classes: 'nav',
                text: 'Home',
                visible: true,
                box: { x: 10, y: 20, width: 40, height: 16 },
                attributes: { href: '/' },
              },
            ],
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'network',
            browserId: browserTab.browserId,
            entries: [],
            total: 12,
            matched: 12,
            detail: {
              id: '41',
              url: 'http://localhost:5173/api/items',
              method: 'POST',
              status: 201,
              statusText: 'Created',
              type: 'fetch',
              mimeType: 'application/json',
              requestHeaders: { authorization: '[redacted, 20 characters]' },
              responseHeaders: { 'content-type': 'application/json' },
              postData: '{"name":"a"}',
              remoteAddress: '127.0.0.1:5173',
              protocol: 'http/1.1',
              startTime: 120.5,
              duration: 8,
              waitingMs: 6.5,
              transferSize: 310,
              body: { size: 14, text: '{"id":"item1"}' },
            },
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'network',
            browserId: browserTab.browserId,
            entries: [
              {
                id: '42',
                url: 'http://localhost:5173/logo.png',
                method: 'GET',
                status: 404,
                type: 'image',
                mimeType: 'text/html',
                startTime: 3,
                duration: 2,
                fromCache: false,
              },
            ],
            total: 12,
            matched: 1,
            cleared: true,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'dialogs',
            browserId: browserTab.browserId,
            policy: {
              confirm: 'accept',
              prompt: 'accept',
              promptText: 'Alice',
              beforeunload: 'dismiss',
            },
          },
          dialogs: [
            {
              type: 'prompt',
              message: 'Name?',
              defaultValue: '',
              action: 'accepted',
              response: 'Alice',
              timestamp: 1760256000000,
            },
          ],
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'upload',
            browserId: browserTab.browserId,
            ref: '@e3',
            files: [{ path: '/Users/me/projects/wevir/a.txt', size: 12 }],
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'download',
            browserId: browserTab.browserId,
            url: 'http://localhost:5173/report.csv',
            filename: 'report.csv',
            path: '/Users/me/projects/wevir/downloads/report.csv',
            size: 2048,
            mimeType: 'text/csv',
            state: 'completed',
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'snapshot',
            browserId: browserTab.browserId,
            url: browserTab.url,
            title: browserTab.title,
            format: 'aria-yaml',
            snapshot: '- listitem "Item 300"\n# The snapshot stopped after 300 nodes.',
            truncated: false,
            stats: {
              nodeCount: 300,
              refCount: 0,
              textLength: 60,
              stoppedAt: 'body > ul > li:nth-of-type(300)',
              maxNodes: 300,
            },
          },
        },
        {
          requestId: ids.browserRequest,
          ok: false,
          error: {
            code: 'browser_script_error',
            message: 'TypeError: Cannot read properties of null',
            retryable: false,
          },
        },
      ],
      invalid: [
        {
          requestId: ids.browserRequest,
          ok: true,
          result: { command: 'click', browserId: browserTab.browserId, ref: '@e2' },
          effects: { navigation: { url: 'http://localhost:5173/', status: 42 } },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'evaluate',
            browserId: browserTab.browserId,
            value: 1,
            type: 'number',
            truncated: false,
            length: 1,
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'upload',
            browserId: browserTab.browserId,
            files: [{ path: '/a.txt', size: -1 }],
          },
        },
        { requestId: 'r1', ok: false, error: { code: 'browser_timeout', message: 'x' } },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'navigate',
            browserId: browserTab.browserId,
            url: 'http://localhost:5173/',
            status: 2.5,
          },
        },
        { requestId: ids.browserRequest, ok: true, result: { command: 'evaluate' } },
        { requestId: ids.browserRequest, ok: false, error: { code: '', message: 'x' } },
      ],
    },
    result: { valid: [{ accepted: true }, { accepted: false }], invalid: [{}] },
  },
  'events.subscribe': {
    params: {
      valid: [
        { sessionId: ids.session, sinceSeq: 0 },
        { sessionId: ids.session, sinceSeq: 12 },
      ],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, sinceSeq: 1.5 }],
    },
    result: {
      valid: [{ subscriptionId: ids.subscription, replayedThroughSeq: 12 }],
      invalid: [{ subscriptionId: ids.subscription }],
    },
  },
  'events.unsubscribe': {
    params: {
      valid: [{ subscriptionId: ids.subscription }],
      invalid: [{ subscriptionId: ids.session }],
    },
    result: empty,
  },
};

type NotificationSamples = {
  [N in NotificationName]: { valid: NotificationParams<N>[]; invalid: unknown[] };
};

export const notificationSamples: NotificationSamples = {
  'plugins.changed': empty,
  'events.event': {
    valid: [{ subscriptionId: ids.subscription, event: eventOf('assistant.delta', 13) }],
    invalid: [
      { event: eventOf('assistant.delta', 13) },
      { subscriptionId: ids.subscription, event: { ...eventOf('turn.started'), seq: 0 } },
    ],
  },
  'account.updated': {
    valid: [
      { account: signedInAccount },
      { account: signingInAccount },
      { account: claudeAccount },
      { account: antigravityInstalling },
      { account: workbuddyAccount },
    ],
    invalid: [{}, { account: { ...signedInAccount, kind: 'gemini' } }],
  },
  'settings.updated': {
    valid: [
      { settings: { sendWhileBusy: 'queue' } },
      { settings: { sendWhileBusy: 'queue', promptSuggestions: true } },
      { settings: { sendWhileBusy: 'queue', autoMemory: false } },
    ],
    invalid: [{ settings: {} }],
  },
  'usage.changed': { valid: [{}], invalid: [null, 'x'] },
  'process.changed': {
    valid: [{ process: agentProcess }, { removed: { id: 'p3', startedAt: TS } }],
    invalid: [{}, { removed: { id: 'p3' } }],
  },
  'terminal.output': {
    valid: [{ terminalId: terminalSample.id, offset: 0, data: '\u001b[1mhi\u001b[0m' }],
    invalid: [{ terminalId: terminalSample.id, data: 'x' }],
  },
  'terminal.changed': {
    valid: [{ terminal: terminalSample }, { removed: { id: terminalSample.id } }],
    invalid: [{}, { removed: {} }],
  },
  'automation.changed': {
    valid: [
      { automationId: ids.automation },
      { automationId: ids.automation, run: automationRunSample },
      { automationId: ids.automation, deleted: true },
    ],
    invalid: [{}, { automationId: ids.automation, deleted: false }],
  },
  'memory.changed': {
    valid: [
      { scope: 'global', name: 'reply-language' },
      { scope: 'project', workspaceId: ids.workspace, name: 'invoice-cents' },
      { scope: 'project', workspaceId: ids.workspace },
    ],
    invalid: [{}, { scope: 'team' }, { scope: 'global', name: 'Bad Name' }],
  },
  'browser.request': {
    valid: [
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'new_tab', args: { url: 'http://localhost:5173/' } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'click',
          args: { browserId: browserTab.browserId, ref: '@e4', modifiers: ['Shift'] },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'wait', args: { browserId: browserTab.browserId, text: 'Saved' } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'snapshot', args: { browserId: browserTab.browserId, offset: 160 } },
      },
      // 0.48.0
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'snapshot',
          args: {
            browserId: browserTab.browserId,
            selector: 'main',
            viewportOnly: true,
            maxNodes: 5000,
          },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'evaluate',
          args: {
            browserId: browserTab.browserId,
            function: '(el) => el.dataset',
            ref: '@e3',
            timeoutMs: 2000,
            maxBytes: 1000,
          },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'query',
          args: {
            browserId: browserTab.browserId,
            selector: 'a',
            frame: '1.0',
            attributes: ['href'],
          },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'network',
          args: { browserId: browserTab.browserId, status: '4xx', method: 'GET', failedOnly: true },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'dialogs',
          args: { browserId: browserTab.browserId, prompt: 'accept', promptText: 'Alice' },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'upload',
          args: { browserId: browserTab.browserId, paths: ['/Users/me/projects/wevir/a.txt'] },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'download',
          args: { browserId: browserTab.browserId, url: 'http://localhost:5173/report.csv' },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'wait',
          args: {
            browserId: browserTab.browserId,
            selector: '#done',
            state: 'visible',
            frame: 'checkout',
          },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'wait',
          args: { browserId: browserTab.browserId, networkIdle: true, idleMs: 500 },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'show', args: { url: 'http://127.0.0.1:3000/' } },
      },
    ],
    invalid: [
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'navigate',
          args: { browserId: browserTab.browserId, url: 'file:///etc/passwd' },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'click', args: { browserId: browserTab.browserId, ref: 'button' } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'snapshot', args: { browserId: browserTab.browserId, maxNodes: 10 } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'upload', args: { browserId: browserTab.browserId, paths: [] } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'download',
          args: { browserId: browserTab.browserId, url: 'file:///etc/hosts' },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'evaluate',
          args: { browserId: browserTab.browserId, function: '() => 1', timeoutMs: 60000 },
        },
      },
    ],
  },
};

// ── 错误 data ─────────────────────────────────────────────────────────

type ErrorDataSamples = {
  [N in keyof typeof ErrorDataSchemas]: { valid: ErrorData<N>; invalid: unknown };
};

export const errorDataSamples: ErrorDataSamples = {
  METHOD_NOT_FOUND: {
    valid: { hostVersion: '0.0.0', hint: '请升级 Wevir Host' },
    invalid: { hostVersion: '0.0.0' },
  },
  INVALID_PARAMS: {
    valid: { issues: [{ path: ['content', 0, 'text'], message: 'Invalid input' }] },
    invalid: { issues: [{ path: 'content', message: 'x' }] },
  },
  INCOMPATIBLE_PROTOCOL: {
    valid: { hostVersion: '0.0.0', protocolVersion: '0.1.0', minProtocolVersion: '0.1.0' },
    invalid: { hostVersion: '0.0.0', protocolVersion: 'v1', minProtocolVersion: '0.1.0' },
  },
  INVALID_STATE: {
    valid: { state: 'error', readOnly: readOnlySession.readOnly },
    invalid: { state: 'gone' },
  },
  SESSION_BUSY: {
    valid: { state: 'running', activeTurn: { turnId: ids.turn, startedAt: TS } },
    invalid: {},
  },
  ALREADY_DECIDED: {
    valid: {
      approvalId: ids.approval,
      status: 'cancelled',
      resolution: { reason: 'turn_cancelled' },
    },
    invalid: { approvalId: ids.approval, status: 'cancelled', resolution: { reason: 'timeout' } },
  },
  CLIENT_MESSAGE_CONFLICT: { valid: { clientMessageId: 'msg-1' }, invalid: { clientMessageId: 1 } },
  RESOURCE_IN_USE: {
    valid: {
      sessionIds: [ids.session],
      worktrees: [{ path: '/Users/me/Wevir/worktrees/ses_x/1-app', branch: 'wevir/fix-login' }],
    },
    invalid: { sessionIds: ['s1'] },
  },
  PENDING_NOT_EDITABLE: {
    valid: { pendingId: ids.pending, status: 'waiting', delivery: 'steer' },
    invalid: { pendingId: ids.pending, status: 'waiting' },
  },
  HANDOFF_STALE: {
    valid: { reasons: ['events', 'notes'] },
    invalid: { reasons: [] },
  },
  GIT_STATE_CHANGED: {
    valid: { head: SHA2, index: INDEX_TOKEN },
    invalid: { head: 'HEAD', index: INDEX_TOKEN },
  },
  WORKSPACE_PATH_INVALID: {
    valid: { path: '/Users/me/gone', reason: 'not_found' },
    invalid: { path: '/Users/me/gone', reason: 'missing' },
  },
  ENGINE_ERROR: {
    valid: { category: 'session_unavailable', message: 'session cwd does not match' },
    invalid: { category: 'fatal', message: 'x' },
  },
};
