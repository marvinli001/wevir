// 仅供测试：各 schema 的合法与非法样例。不从 index.ts 导出，不进入构建产物。
// 合法样例以 TS 类型约束（与 z.infer 一致），非法样例各自只破坏一处，便于定位。

import type { ApprovalRule } from './approval-rules.js';
import type { Automation, AutomationCheckResult, AutomationRun } from './automations.js';
import type { BrowserTabInfo } from './browser.js';
import type { Channel, ChannelCoordinator, ChannelPost, ChannelThread } from './channels.js';
import type { ClientIdentity } from './common.js';
import type { Device, PairingOffer, RemoteStatus } from './devices.js';
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
  SecondOpinion,
  Session,
  SessionGoal,
  SessionInsight,
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
import type { Guardrail, GuardrailBlocked, RepoHook } from './guardrails.js';
import type { Hook, HookOutcome } from './hooks.js';
import type { InboxItem } from './inbox.js';
import type { LspInstallRun, LspServerStatus } from './lsp.js';
import type { WevirMarketIndex } from './market.js';
import {
  IMAGE_UPLOAD_DATA_MAX_LENGTH,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
} from './methods.js';
import type { NotificationIntent } from './notifications.js';
import type { OfficeEngineStatus } from './office.js';
import type { PreviewCandidate, PreviewConfig } from './preview.js';
import type { HostProcess } from './processes.js';
import type { PushState } from './push.js';
import type { InstallRun, ReadinessReport } from './readiness.js';
import type { RetroSummary, SessionRetro } from './retro.js';
import type { ReviewComment } from './review.js';
import type { SimulatorDevice } from './simulator.js';
import type { SpeechLocalStatus } from './speech.js';
import type { Terminal } from './terminals.js';
import type {
  Profile,
  ProfileItem,
  ProfileLayer,
  ProfileVersionRef,
  ProfileVersionSummary,
} from './tuning.js';
import type { TuningMetrics, TuningProposal } from './tuning-proposals.js';
import type {
  CheckDefinition,
  RepairChain,
  SessionAcceptance,
  VerificationRun,
} from './verification.js';
import type { WritingStyleProfile } from './writing-style.js';

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
  /** 电脑操作的请求（0.114.0）。 */
  computerRequest: `crq_${ULID}`,
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
  /** 项目安装（0.70.0）。 */
  installRun: `ins_${ULID}`,
  /** 第二意见（0.75.0）与给意见的会话。 */
  opinion: `opn_${ULID}`,
  opinionSession: 'ses_01JA2B3C4D5E6F7G8H9JKMNPR5',
  /** 你应该知道（0.79.0）。 */
  insight: `isg_${ULID}`,
  /** 审批规则（0.80.0）。 */
  approvalRule: `arl_${ULID}`,
  /** 档案版本（0.85.0）。 */
  profileVersion: `pfv_${ULID}`,
  profileVersion2: 'pfv_01JA2B3C4D5E6F7G8H9JKMNPR2',
  /** 护栏（0.86.0）。 */
  guardrail: `grd_${ULID}`,
  /** 调优的建议（0.87.0）。 */
  tuningProposal: `tpr_${ULID}`,
  tuningProposal2: 'tpr_01JA2B3C4D5E6F7G8H9JKMNPR3',
  /** 远程设备与配对（0.107.0）。 */
  device: `dev_${ULID}`,
  pairing: `prg_${ULID}`,
  pairingRequest: `prq_${ULID}`,
  /** 频道与帖子（0.120.0）。 */
  channel: `chn_${ULID}`,
  channelPost: `cpo_${ULID}`,
  channelPost2: 'cpo_01JA2B3C4D5E6F7G8H9JKMNPR1',
  coordinator: 'ses_01JA2B3C4D5E6F7G8H9JKMNPR7',
} as const;

/** 32 字节的 base64url（0.107.0）：公钥与配对秘密的样本。 */
const KEY_A = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';
const KEY_B = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

const SHA1 = '4f1c2e9a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e';
const SHA2 = '9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';

/** 配对过的一台手机（0.107.0）。 */
export const deviceSample: Device = {
  id: ids.device,
  name: 'iPhone',
  platform: 'ios',
  publicKey: KEY_B,
  permissions: ['session.read', 'session.write', 'workspace.read'],
  createdAt: TS,
  lastSeenAt: TS2,
  status: 'active',
};

/** 浏览器里的网页客户端（0.117.0）。 */
export const webDeviceSample: Device = {
  ...deviceSample,
  name: 'Chrome',
  platform: 'web',
};

/** 开了推送、令牌已绑定的一台手机（0.112.0）。 */
export const devicePushSample: Device = {
  ...deviceSample,
  push: { enabled: true, registered: true },
};

/** 设备看到的自己的推送（0.112.0）：开着、令牌已绑定。 */
export const pushStateSample: PushState = {
  enabled: true,
  registered: true,
  gatewayUrl: 'https://push.wevir.si',
  routeId: KEY_B,
};

/** 一个配对窗口（0.107.0）：远程监听还没开，没有候选地址。 */
export const pairingOfferSample: PairingOffer = {
  pairingId: ids.pairing,
  uri: `wevir://pair?v=1&k=${KEY_A}&r=${KEY_B}&s=${KEY_A}&n=Mac`,
  shortCode: '7KQ2M9XD',
  expiresAt: TS2,
  hostPublicKey: KEY_A,
  routeId: KEY_B,
  candidates: [],
};

/** 网页配对的窗口（0.117.0）：https 链接，经官方中继。 */
export const webPairingOfferSample: PairingOffer = {
  ...pairingOfferSample,
  uri: `https://web.wevir.si/pair#v=1&k=${KEY_A}&r=${KEY_B}&s=${KEY_A}&n=Mac&relay=wss%3A%2F%2Frelay.wevir.si`,
  relayUrl: 'wss://relay.wevir.si',
  web: true,
};

/** 远程监听（0.109.0）：局域网与 Tailscale 都在监听，一台设备连着。 */
export const remoteStatusSample: RemoteStatus = {
  listening: true,
  port: 47_830,
  interfaces: [
    {
      name: 'en0',
      family: 'IPv4',
      kind: 'lan',
      addresses: ['192.168.1.20'],
      selected: true,
      listening: ['192.168.1.20'],
    },
    {
      name: 'en1',
      family: 'IPv4',
      kind: 'lan',
      addresses: ['192.168.1.21'],
      selected: false,
      listening: [],
    },
    {
      name: 'utun4',
      family: 'IPv4',
      kind: 'tailscale',
      addresses: ['100.101.102.103'],
      selected: true,
      listening: ['100.101.102.103'],
    },
  ],
  magicDnsName: 'mac.tailnet-1234.ts.net',
  advertising: true,
  connections: 1,
};

/** 中继（0.110.0）：只开了中继，连着自建的中继，一台设备经中继连着。 */
export const remoteRelaySample: RemoteStatus = {
  listening: false,
  port: 47_830,
  interfaces: [],
  advertising: false,
  connections: 1,
  relay: { state: 'connected', url: 'wss://relay.example.com', connections: 1 },
};

/** 中继断了，正在退避重连。 */
export const remoteRelayRetrySample: RemoteStatus = {
  ...remoteRelaySample,
  connections: 0,
  relay: {
    state: 'connecting',
    url: 'wss://relay.example.com/wevir',
    connections: 0,
    error: { reason: 'unreachable', message: 'connect ECONNREFUSED' },
  },
};

/** 中继失败的细节（0.111.0）：那个地址回了 HTTP 404，不是中继。 */
export const remoteRelayRejectedSample: RemoteStatus = {
  ...remoteRelayRetrySample,
  relay: {
    state: 'connecting',
    url: 'wss://relay.example.com/wevir',
    connections: 0,
    error: { reason: 'rejected', message: 'relay answered HTTP 404', httpStatus: 404 },
  },
};

/** 中继的 TLS 证书验不过（0.111.0）。 */
export const remoteRelayCertificateSample: RemoteStatus = {
  ...remoteRelayRetrySample,
  relay: {
    state: 'connecting',
    url: 'wss://relay.example.com',
    connections: 0,
    error: { reason: 'unreachable', message: 'self-signed certificate', certificate: true },
  },
};

/** 推送（0.112.0）：直连监听着，推送开着，上一次网关连不上。 */
export const remotePushSample: RemoteStatus = {
  ...remoteStatusSample,
  push: {
    state: 'unavailable',
    gatewayUrl: 'https://push.wevir.si',
    devices: 1,
    lastSentAt: TS,
    error: { reason: 'unreachable', message: 'fetch failed' },
  },
};

/** 远程访问关着，端口被占用的那次留下的错误。 */
export const remoteOffSample: RemoteStatus = {
  listening: false,
  port: 47_830,
  interfaces: [],
  advertising: false,
  connections: 0,
  error: { reason: 'port_in_use', message: 'address already in use' },
};

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

/** agent 报出的审查发现（0.83.0）：存成批注，带标题、严重度与提出它的回合。 */
export const findingComment: ReviewComment = {
  ...reviewComment,
  body: '负数换算差一度：`Math.round` 对 -0.5 取到 0。',
  anchor: { state: 'current', startLine: 12, endLine: 14 },
  finding: { title: '负数温度换算错误', priority: 1, confidence: 0.8, turnId: ids.turn },
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

/** 一次项目安装（0.70.0）：网络失败。 */
export const installRun: InstallRun = {
  id: ids.installRun,
  workspaceId: ids.workspace,
  root: '/home/u/projects/demo',
  planId: 'pln_5c2a91e0',
  path: '',
  manager: 'pnpm',
  command: 'pnpm install --frozen-lockfile',
  status: 'failed',
  reason: 'network',
  startedAt: TS,
  finishedAt: TS2,
  durationMs: 5250,
  exitCode: 1,
  timeoutMs: 900_000,
  bytes: 420,
  summary: 'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/zod: getaddrinfo ENOTFOUND',
};

/** 项目环境的预检报告（0.70.0）：依赖比锁文件旧，有一个安装方案。 */
export const readinessReport: ReadinessReport = {
  workspaceId: ids.workspace,
  root: '/home/u/projects/demo',
  status: 'not_ready',
  checkedAt: TS,
  durationMs: 320,
  projects: [{ path: '', ecosystems: ['node'] }],
  items: [
    {
      id: 'package_manager::pnpm',
      kind: 'package_manager',
      name: 'pnpm',
      path: '',
      status: 'ready',
      required: '12.6.0',
      found: '12.6.0',
      blocking: true,
      evidence: [
        { kind: 'file', path: 'package.json', detail: 'packageManager: pnpm@12.6.0' },
        { kind: 'command', command: 'pnpm --version', exitCode: 0, output: '12.6.0' },
      ],
    },
    {
      id: 'dependencies::node',
      kind: 'dependencies',
      name: 'node_modules',
      path: '',
      status: 'incompatible',
      reason: 'dependencies_outdated',
      blocking: true,
      evidence: [
        { kind: 'file', path: 'node_modules/.modules.yaml', detail: 'older than pnpm-lock.yaml' },
      ],
    },
    {
      id: `check::${ids.check}`,
      kind: 'check',
      name: 'test',
      path: '',
      status: 'ready',
      blocking: false,
      checkId: ids.check,
      evidence: [{ kind: 'file', path: 'package.json', detail: 'scripts.test' }],
    },
  ],
  plans: [
    {
      id: 'pln_5c2a91e0',
      path: '',
      manager: 'pnpm',
      command: 'pnpm install --frozen-lockfile',
      lockfile: 'pnpm-lock.yaml',
      writesLockfile: false,
      reason: 'dependencies_outdated',
      scripts: { project: ['postinstall'], dependencies: 'restricted' },
      credentials: [{ name: 'NPM_TOKEN', source: 'wevir' }],
    },
  ],
  network: {
    registries: [
      { ecosystem: 'node', url: 'https://registry.npmjs.org/', source: 'default', auth: 'none' },
      { ecosystem: 'node', url: 'https://npm.example.com/', source: '.npmrc', auth: 'configured' },
    ],
    proxy: ['HTTPS_PROXY'],
    agent: {
      engine: 'codex',
      permissionMode: 'on_request',
      network: 'sandboxed',
      domains: 'not_enforced',
    },
    advice: ['install_by_user', 'domains_not_enforced'],
  },
  install: installRun,
};

/** 一次语言服务器安装（0.71.0）：装完验证通过。 */
export const lspInstallSample: LspInstallRun = {
  id: 'lsi_01JBZ8Y5W1ZK3M4N5P6Q7R8S9T',
  serverId: 'typescript',
  root: '/home/u/projects/demo',
  planId: 'project-add-typescript',
  scope: 'project',
  command: 'pnpm add -D typescript',
  status: 'succeeded',
  startedAt: TS,
  endedAt: TS2,
  exitCode: 0,
  output: '$ pnpm add -D typescript\n+ typescript 7.0.2\n',
  verification: { server: 'tsc --lsp (TypeScript 7.0.2)', file: 'src/index.ts', diagnostics: 2 },
};

/** 语言服务器的状态（0.71.0）：在运行的，与没装、带方案的。 */
export const lspRunningSample: LspServerStatus = {
  serverId: 'typescript',
  language: 'TypeScript/JavaScript',
  root: '/home/u/projects/demo',
  state: 'running',
  name: 'tsc --lsp (TypeScript 7.0.2)',
  path: '/home/u/projects/demo/node_modules/@typescript/typescript-darwin-arm64/lib/tsc',
  source: 'project',
  version: '7.0.2',
  capabilities: ['definition', 'references', 'hover', 'rename', 'codeAction'],
  startedAt: TS,
  lastDiagnosticsAt: TS2,
  install: lspInstallSample,
};

export const lspMissingSample: LspServerStatus = {
  serverId: 'go',
  language: 'Go',
  root: '/home/u/projects/demo/tool',
  state: 'missing',
  reason: 'gopls not found. Install it: go install golang.org/x/tools/gopls@latest',
  plans: [
    {
      id: 'user-go',
      scope: 'user',
      command: 'go install golang.org/x/tools/gopls@latest',
      runnable: true,
    },
  ],
};

/** 一份任务回顾（0.76.0）：改了代码、检查通过但之后又改了文件、有未提交的改动。 */
export const sessionRetro: SessionRetro = {
  sessionId: ids.session,
  title: '温度换算支持开尔文',
  schemaVersion: 2,
  throughSeq: 42,
  builtAt: TS,
  checkedAt: TS2,
  build: 'incremental',
  running: false,
  goal: {
    recorded: true,
    request: {
      id: 'e2',
      text: '把温度换算改成支持开尔文',
      ref: { kind: 'event', seq: 2, turnId: ids.turn },
    },
  },
  done: [
    {
      id: 'e9.0',
      text: '实现 toKelvin',
      origin: 'todo',
      status: 'completed',
      ref: { kind: 'event', seq: 9, turnId: ids.turn },
    },
  ],
  open: [
    {
      id: 'b:t2',
      text: '补文档',
      origin: 'board',
      status: 'pending',
      owner: ids.childSession,
      ref: { kind: 'event', seq: 30 },
    },
  ],
  boardRecorded: true,
  turns: [
    {
      id: `t:${ids.turn}`,
      turnId: ids.turn,
      seq: 3,
      endSeq: 20,
      outcome: 'completed',
      text: '把温度换算改成支持开尔文',
      kind: 'user',
      files: ['src/convert.ts'],
      commands: 2,
      diff: 'available',
      fileCount: 1,
      added: 12,
      removed: 3,
      at: TS,
    },
  ],
  chapters: [
    {
      id: 'h4',
      text: '实现',
      summary: '改换算函数并补测试',
      ref: { kind: 'event', seq: 4, turnId: ids.turn },
      turns: 1,
      at: TS,
    },
  ],
  hiddenTurns: 1,
  changes: {
    recorded: true,
    repo: true,
    files: [
      {
        id: 'f:src/convert.ts',
        path: 'src/convert.ts',
        turnIds: [ids.turn],
        diff: 'deleted',
      },
    ],
    commits: [{ id: `c:${SHA1}`, sha: SHA1, subject: 'Add kelvin', at: TS2 }],
    uncommitted: 2,
    branch: 'main',
    head: SHA1,
  },
  verification: {
    recorded: true,
    checks: [
      {
        id: `v:${ids.verificationRun}`,
        checkId: ids.check,
        runId: ids.verificationRun,
        name: 'test',
        command: 'pnpm test',
        kind: 'test',
        status: 'passed',
        evidence: 'outdated',
        codeState: { kind: 'git', head: SHA1, tree: SHA2 },
        tests: { passed: 4, failed: 0, skipped: 0 },
        exitCode: 0,
        turnId: ids.turn,
        seq: 24,
        finishedAt: TS2,
        earlier: [
          {
            runId: 'vrn_01JA2B3C4D5E6F7G8H9JKMNPR2',
            status: 'failed',
            reason: 'exit_code',
            seq: 16,
            turnId: ids.turn,
          },
        ],
      },
    ],
    acceptance: 'unverified',
    commands: [
      {
        id: 'e12',
        text: 'pnpm test',
        status: 'completed',
        ref: { kind: 'event', seq: 12, turnId: ids.turn },
      },
    ],
    codeState: { kind: 'git', head: SHA1, tree: SHA1 },
  },
  review: {
    recorded: true,
    comments: [
      {
        id: `r:${ids.reviewComment}`,
        text: '这里要处理负数',
        path: 'src/convert.ts',
        line: 12,
        status: 'pending',
        outdated: true,
        ref: {
          kind: 'review',
          commentId: ids.reviewComment,
          path: 'src/convert.ts',
          source: { kind: 'uncommitted' },
        },
      },
    ],
  },
  decisions: [
    { id: 'e15', kind: 'steer', text: '别改公共接口', ref: { kind: 'event', seq: 15 } },
    { id: 'e40', kind: 'undone', text: '', ref: { kind: 'event', seq: 40 } },
  ],
  delivery: {
    checks: 'outdated',
    commit: 'uncommitted',
    push: 'not_pushed',
    ci: 'unknown',
    deploy: 'unknown',
    ahead: 1,
  },
  next: [
    {
      id: `n:v:${ids.verificationRun}`,
      kind: 'rerun_check',
      text: 'test',
      ref: { kind: 'verification', runId: ids.verificationRun, seq: 24 },
    },
  ],
  sessions: [
    {
      id: `s:${ids.childSession}`,
      text: '补文档',
      sessionId: ids.childSession,
      relation: 'opened',
      source: 'deleted',
      ref: { kind: 'session', sessionId: ids.childSession },
    },
  ],
  memories: [
    {
      id: 'e18',
      text: 'kelvin-rounding',
      scope: 'project',
      name: 'kelvin-rounding',
      operation: 'save',
      source: 'available',
      ref: { kind: 'memory', scope: 'project', name: 'kelvin-rounding' },
    },
  ],
};

/** 一份模型摘要（0.76.0）：一点有出处，一点是推断。 */
export const retroSummary: RetroSummary = {
  points: [
    { text: '开尔文换算已实现，测试通过的是旧版本。', refs: ['e9.0', `v:${ids.verificationRun}`] },
    { text: '负数处理可能还没做。', refs: [], inferred: true },
  ],
  providerId: 'deepseek-official',
  modelId: 'deepseek-chat',
  throughSeq: 42,
  generatedAt: TS2,
  inputBytes: 3200,
  outputBytes: 210,
  usage: { inputTokens: 1100, outputTokens: 80 },
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

/** 开发服务器预览（0.84.0）：用户起的，端口已能连上。 */
export const previewProcess: HostProcess = {
  id: 'p4',
  workspaceId: ids.workspace,
  source: { kind: 'preview', sessionId: ids.session, startedBy: 'user' },
  name: 'web',
  command: 'pnpm run dev',
  cwd: '/home/u/projects/demo/apps/web',
  pid: 4260,
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: TS,
  bytes: 512,
  stopSignals: ['SIGINT', 'SIGTERM', 'SIGKILL'],
  preview: {
    name: 'web',
    root: '/home/u/projects/demo',
    port: 5173,
    url: 'http://localhost:5173',
    ready: true,
  },
};

/** 运行配置（0.84.0）。 */
/** 听写（0.92.0）：本机模型没装 / 装好了。 */
export const speechLocalMissing: SpeechLocalStatus = {
  state: 'missing',
  modelName: 'SenseVoice Small',
  downloadBytes: 166_427_732,
};
export const speechLocalReady: SpeechLocalStatus = {
  ...speechLocalMissing,
  state: 'ready',
  installedBytes: 259_000_000,
};

/** 办公文档预览引擎（0.138.0）：没装 / 装好了。 */
export const officeEngineMissing: OfficeEngineStatus = {
  state: 'missing',
  engineName: 'LibreOffice',
  version: '0.2.0',
  backend: 'native',
  downloadBytes: 61_000_000,
};
export const officeEngineReady: OfficeEngineStatus = {
  ...officeEngineMissing,
  state: 'ready',
  installedBytes: 174_000_000,
};

export const previewConfig: PreviewConfig = {
  name: 'web',
  command: 'pnpm run dev',
  cwd: 'apps/web',
  port: 5173,
  addedBy: 'user',
  createdAt: TS,
  updatedAt: TS2,
};

export const previewCandidate: PreviewCandidate = {
  name: 'storybook',
  command: 'pnpm run storybook',
  cwd: '',
  port: 6006,
  origin: 'package_script',
  file: 'package.json',
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

/** iOS 模拟器（0.122.0）：已启动、在一个会话里 attach 过的 iPhone。 */
export const simulatorDeviceSample: SimulatorDevice = {
  udid: '8A4F2C1E-3B5D-4E6F-9A7B-1C2D3E4F5A6B',
  name: 'iPhone 17 Pro',
  platform: 'ios',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  osVersion: '26.5',
  family: 'iphone',
  deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  state: 'booted',
  available: true,
  attachedBy: [ids.session],
};

/** iOS 模拟器（0.122.0）：关着的 iPad，运行时已不可用。 */
export const simulatorShutdownSample: SimulatorDevice = {
  udid: '1B2C3D4E-5F60-4718-8293-A4B5C6D7E8F9',
  name: 'iPad Air 13-inch (M3)',
  platform: 'ios',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
  osVersion: '',
  family: 'ipad',
  state: 'shutdown',
  available: false,
  attachedBy: [],
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
export const writingStyleProfile: WritingStyleProfile = {
  content: '> 来自 40 条聊天 · 2026 年 10 月更新。\n\n## 整体\n\n- 句子短，先说结论。',
  updatedAt: TS,
  updatedBy: 'agent',
  setupComplete: true,
  revision: 'a1b2c3d4e5f60718',
};

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

/** 带环境变量的环境（0.130.0）。 */
export const environmentWithVariables: Environment = {
  ...environment,
  variables: [
    { name: 'STRIPE_SECRET_KEY', preview: 'sk_test_51...gGGa' },
    { name: 'NODE_ENV', preview: '••••••••' },
  ],
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

/** Devin（0.88.0）：应用内经浏览器登录的 Devin CLI，Wevir 下载的那份。 */
export const devinAccount: AccountState = {
  kind: 'devin',
  status: 'signed_in',
  email: 'me@example.com',
  planLabel: 'Pro',
  signIn: 'in_app',
  loginMethods: ['browser'],
  loginCommand: '"/Users/me/.wevir/engines/devin/runtime/versions/3000.11.92/bin/devin" auth login',
  installed: true,
  version: '3000.11.92',
  executablePath: '/Users/me/.wevir/engines/devin/runtime/versions/3000.11.92/bin/devin',
};
/** 0.88.0：Devin 登录中（CLI 自己打开浏览器，没有 `authUrl`）。 */
export const devinSigningIn: AccountState = {
  kind: 'devin',
  status: 'signing_in',
  signIn: 'in_app',
  loginMethods: ['browser'],
  loginCommand: 'devin auth login',
  installed: true,
  version: '3000.11.92',
  login: { loginId: 'login-devin', method: 'browser', startedAt: TS },
};
export const devinProvider: ProviderProfile = {
  id: 'devin',
  kind: 'devin',
  displayName: 'Devin',
  models: [
    { id: 'adaptive', displayName: 'Adaptive' },
    { id: 'swe-1-6-fast', displayName: 'SWE-1.6 Fast' },
  ],
  defaultModelId: 'swe-1-6-fast',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};

/** GitHub Copilot（0.125.0）：设备码登录的 Copilot CLI，用户自己装的；额度是每月的高级请求。 */
export const copilotAccount: AccountState = {
  kind: 'copilot',
  status: 'signed_in',
  email: 'octocat',
  signIn: 'in_app',
  loginMethods: ['device_code'],
  loginCommand: 'copilot login',
  installed: true,
  version: '1.0.103',
  executablePath: '/opt/homebrew/bin/copilot',
  rateLimits: {
    primary: { usedPercent: 12.5, period: 'monthly', scope: 'Premium requests', resetsAt: TS },
    windows: [{ usedPercent: 12.5, period: 'monthly', scope: 'Premium requests', resetsAt: TS }],
  },
};
/** 0.125.0：Copilot 登录中（`copilot login --device-code` 给出的网址与码）。 */
export const copilotSigningIn: AccountState = {
  kind: 'copilot',
  id: 'copilot-7c1e',
  status: 'signing_in',
  signIn: 'in_app',
  loginMethods: ['device_code'],
  loginCommand: 'COPILOT_HOME="/Users/me/.wevir/accounts/copilot-7c1e/copilot" copilot login',
  installed: true,
  version: '1.0.103',
  multiAccount: true,
  login: {
    loginId: 'login-copilot',
    method: 'device_code',
    verificationUrl: 'https://github.com/login/device',
    userCode: 'WDJB-MJHT',
    startedAt: TS,
  },
};
export const copilotProvider: ProviderProfile = {
  id: 'copilot',
  kind: 'copilot',
  displayName: 'GitHub Copilot',
  models: [
    { id: 'auto', displayName: 'Auto' },
    { id: 'claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' },
  ],
  defaultModelId: 'auto',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};
/** Kiro（0.141.0）：设备码登录的 Kiro CLI，Wevir 下载的；只有首个账号，可选 Builder ID、Google 或 GitHub。 */
export const kiroAccount: AccountState = {
  kind: 'kiro',
  status: 'signed_in',
  email: 'me@example.com',
  signIn: 'in_app',
  loginMethods: ['device_code'],
  loginCommand: 'kiro-cli login',
  installed: true,
  version: '2.36.0',
  executablePath: '/Users/me/.local/bin/kiro-cli',
};
/** 0.141.0：Kiro 登录中（`kiro-cli login --use-device-flow` 给出的网址与码）。 */
export const kiroSigningIn: AccountState = {
  kind: 'kiro',
  status: 'signing_in',
  signIn: 'in_app',
  loginMethods: ['device_code'],
  loginCommand: 'kiro-cli login',
  installed: true,
  version: '2.36.0',
  login: {
    loginId: 'login-kiro',
    method: 'device_code',
    verificationUrl: 'https://view.awsapps.com/start/#/device?user_code=RGDP-CFQG',
    userCode: 'RGDP-CFQG',
    startedAt: TS,
  },
};
/** 0.141.0：Kiro 没登录时可选的登录方式。 */
export const kiroSignedOut: AccountState = {
  kind: 'kiro',
  status: 'signed_out',
  signIn: 'in_app',
  loginMethods: ['device_code'],
  loginOptions: [
    { id: 'builder-id', label: 'AWS Builder ID' },
    { id: 'google', label: 'Google' },
    { id: 'github', label: 'GitHub' },
  ],
  loginCommand: 'kiro-cli login',
  installed: true,
  version: '2.36.0',
};
export const kiroProvider: ProviderProfile = {
  id: 'kiro',
  kind: 'kiro',
  displayName: 'Kiro',
  models: [
    { id: 'auto', displayName: 'Auto' },
    { id: 'claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' },
  ],
  defaultModelId: 'auto',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
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

/** 给意见的会话（0.75.0）：在 Host 开的 worktree 里，用另一个来源。 */
export const opinionSession: Session = {
  ...idleSession,
  id: ids.opinionSession,
  cwd: '/Users/me/.wevir/worktrees/ses_01JA2B3C4D5E6F7G8H9JKMNPR5/1-wevir',
  providerId: 'claude',
  modelId: 'claude-opus-5-5',
  title: '第二意见：修复登录',
  worktrees: [
    {
      workspaceId: ids.workspace,
      path: '/Users/me/.wevir/worktrees/ses_01JA2B3C4D5E6F7G8H9JKMNPR5/1-wevir',
      branch: 'wevir/opinion-8h9jkmnpr5',
    },
  ],
  opinionOf: { sessionId: ids.session, opinionId: ids.opinion },
  lastSeq: 1,
};

/** 第二意见（0.75.0）：还在看。 */
export const runningOpinion: SecondOpinion = {
  id: ids.opinion,
  sessionId: ids.opinionSession,
  providerId: 'claude',
  modelId: 'claude-opus-5-5',
  requestedBy: 'user',
  focus: '登录失败后的重试是否会重复提交',
  basis: { turnId: ids.turn, head: SHA1, branch: 'fix-login', base: SHA2 },
  status: 'running',
  createdAt: TS,
  updatedAt: TS,
};

/** 第二意见（0.75.0）：有了意见，已引用进原会话。 */
export const quotedOpinion: SecondOpinion = {
  ...runningOpinion,
  status: 'ready',
  outcome: 'completed',
  text: '1. src/login.ts:42 重试前没有清掉上一次的 token，第二次提交会带旧 token。',
  quoted: { at: TS2, turnId: ids.turn },
  updatedAt: TS2,
};

/** 你应该知道（0.79.0）：刚提出，等用户处理。 */
export const openInsight: SessionInsight = {
  id: ids.insight,
  turnId: ids.turn,
  tag: 'heads_up',
  summary: '为了让构建通过，agent 改了全局的 ~/.npmrc，别的项目也会受影响。',
  title: '全局 npm 配置被改了',
  detail:
    '- **~/.npmrc** 是这台电脑上所有项目共用的 npm 设置。\n- 这次加了 `legacy-peer-deps=true`，别的项目装依赖时也会跳过版本检查。\n- 只想对这个项目生效，**改到项目里的 .npmrc**。',
  status: 'open',
  throughSeq: 41,
  createdAt: TS,
  updatedAt: TS,
};

/** 你应该知道（0.79.0）：用户标为已知。 */
export const knownInsight: SessionInsight = { ...openInsight, status: 'known', updatedAt: TS2 };

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

/** 审批规则（0.80.0）：审批卡片上选了“总是允许”加的项目规则，用过两次。 */
export const approvalRule: ApprovalRule = {
  id: ids.approvalRule,
  workspaceId: ids.workspace,
  kind: 'command_prefix',
  prefix: ['git', 'status'],
  source: 'approval',
  sourceSessionId: ids.session,
  sourceApprovalId: ids.approval,
  createdAt: TS,
  useCount: 2,
  lastUsedAt: TS2,
};

const HASH_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HASH_B = '9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f';
const HASH_C = '3f9a2c1e00000000000000000000000000000000000000000000000000000001';

/** 档案的条目（0.85.0）：项目里的 AGENTS.md。 */
export const profileItem: ProfileItem = {
  id: '/Users/me/projects/wevir/AGENTS.md',
  label: 'AGENTS.md',
  scope: 'project',
  hash: HASH_A,
  text: true,
  path: '/Users/me/projects/wevir/AGENTS.md',
};

export const profileLayer: ProfileLayer = { key: 'rules', hash: HASH_B, items: [profileItem] };

/** 一份档案：规则文件一条，连接器一条（只有键名，没有文本），其余层空。 */
export const profile: Profile = {
  fingerprint: HASH_C,
  wevirVersion: '0.1.0-beta.240',
  layers: [
    profileLayer,
    {
      key: 'connectors',
      hash: HASH_A,
      items: [
        {
          id: 'github',
          label: 'github',
          scope: 'global',
          hash: HASH_B,
          detail: 'npx -y github-mcp',
        },
      ],
    },
  ],
};

export const profileVersionRef: ProfileVersionRef = {
  id: ids.profileVersion,
  seq: 7,
  fingerprint: HASH_C,
};

export const profileVersionSummary: ProfileVersionSummary = {
  ...profileVersionRef,
  workspaceId: ids.workspace,
  createdAt: TS,
  sessions: 14,
  changes: [{ key: 'rules', added: 0, removed: 0, modified: 1 }],
};

/** 护栏规则（0.86.0）：项目里的结束前检查，与全局的禁止命令。 */
export const guardrail: Guardrail = {
  id: ids.guardrail,
  workspaceId: ids.workspace,
  name: '测试通过才结束',
  rule: { kind: 'stop_check', command: 'pnpm test', maxAttempts: 3, timeoutSec: 600 },
  enabled: true,
  revision: 2,
  createdAt: TS,
  updatedAt: TS2,
  hits: 4,
  lastHitAt: TS2,
};

export const globalGuardrail: Guardrail = {
  id: 'grd_01JA2B3C4D5E6F7G8H9JKMNPR5',
  rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
  enabled: false,
  revision: 1,
  createdAt: TS,
  updatedAt: TS,
  hits: 0,
};

/** 仓库自带的 hook（0.86.0）：启用过，内容没变。 */
export const repoHook: RepoHook = {
  id: '.codex/hooks.json:pre_tool_use:0:0',
  file: '.codex/hooks.json',
  event: 'PreToolUse',
  matcher: 'Bash',
  handler: 'command',
  command: './scripts/check-command.sh',
  timeoutSec: 600,
  hash: 'sha256:d4f69cdd2c00f2ca673c7703b2aa6420430b66df86546d5334979761548590b4',
  status: 'enabled',
  enabledAt: TS,
};

/** 一次拦截（0.86.0）。 */
export const guardrailBlocked: GuardrailBlocked = {
  guardrailId: ids.guardrail,
  kind: 'stop_check',
  action: 'continued',
  turnId: ids.turn,
  command: 'pnpm test',
  reason: 'Guardrail check `pnpm test` failed (exit 1). Fix the failures before finishing.',
  attempt: 1,
  maxAttempts: 3,
};

/** Wevir 自己的一条生命周期钩子（0.137.0）。 */
export const wevirHook: Hook = {
  id: `hok_${ULID}`,
  source: 'wevir',
  workspaceId: ids.workspace,
  name: '格式化',
  event: 'PostToolUse',
  matcher: 'Edit',
  handler: 'command',
  command: 'pnpm exec biome format --write .',
  timeoutSec: 60,
  engines: ['*'],
  status: 'enabled',
};

/** 仓库里 `.claude/settings.json` 的一条（0.137.0）：启用后脚本变了。 */
export const projectHook: Hook = {
  id: 'claude_project:.claude/settings.json:PreToolUse:0:0',
  source: 'claude_project',
  file: '.claude/settings.json',
  event: 'PreToolUse',
  matcher: 'Bash',
  handler: 'command',
  command: './scripts/check.sh',
  engines: ['claude'],
  status: 'changed',
  hash: 'sha256:d4f69cdd2c00f2ca673c7703b2aa6420430b66df86546d5334979761548590b4',
  enabledAt: TS,
};

/** 一条 hook 拦下了命令（0.137.0）。 */
export const hookOutcome: HookOutcome = {
  hookId: projectHook.id,
  source: 'claude_project',
  event: 'PreToolUse',
  action: 'blocked',
  turnId: ids.turn,
  tool: 'Bash',
  command: './scripts/check.sh',
  reason: 'rm -rf is not allowed here',
};

/** 调优的建议（0.87.0）：AGENTS.md 加两行，证据是一个回合与一次验证。 */
export const ruleProposal: TuningProposal = {
  id: ids.tuningProposal,
  workspaceId: ids.workspace,
  sessionId: ids.session,
  sessionTitle: '修复 CI',
  kind: 'rule',
  title: '测试前先 pnpm build',
  target: 'AGENTS.md',
  change: {
    kind: 'rule',
    path: '/Users/me/projects/wevir/AGENTS.md',
    before: '# AGENTS.md\n',
    after: '# AGENTS.md\n\n- Run `pnpm build` before `pnpm test`.\n',
  },
  evidence: [
    {
      id: 't:trn_01JA2B3C4D5E6F7G8H9JKMNPQR',
      text: '测试为什么挂了',
      turn: 4,
      ref: { kind: 'event', seq: 40, turnId: ids.turn },
    },
    { id: 'e57', text: 'pnpm test failed' },
  ],
  status: 'pending',
  usage: { inputTokens: 1520, outputTokens: 310 },
  providerId: 'pvd_deepseek',
  modelId: 'deepseek-chat',
  createdAt: TS,
};

/** 采纳了的记忆建议：下一个会话开了 v8，用它的两个会话里验证通过 3 次、共 4 次。 */
export const memoryProposal: TuningProposal = {
  ...ruleProposal,
  id: ids.tuningProposal2,
  kind: 'memory',
  title: '金额以分为单位',
  target: 'invoice-cents',
  change: {
    kind: 'memory',
    name: 'invoice-cents',
    type: 'project',
    description: '金额字段以分存储',
    before: '',
    after: 'Invoice amounts are stored in cents; never use floats.',
  },
  evidence: [],
  status: 'accepted',
  edited: true,
  decidedAt: TS2,
  version: { ...profileVersionRef, seq: 8 },
  stats: { sessions: 2, checks: { passed: 3, total: 4 } },
};

/** 拒绝了的护栏建议。 */
export const guardrailProposal: TuningProposal = {
  ...ruleProposal,
  id: 'tpr_01JA2B3C4D5E6F7G8H9JKMNPR4',
  kind: 'guardrail',
  title: '不许强推',
  target: 'forbidden_command',
  change: {
    kind: 'guardrail',
    name: '不许强推',
    rule: { kind: 'forbidden_command', match: 'regex', pattern: 'git\\s+push\\s+(-f|--force)' },
  },
  status: 'rejected',
  decidedAt: TS2,
  usage: undefined,
};

/** 一组会话的指标（0.108.0）。 */
export const tuningMetrics: TuningMetrics = {
  sessions: 5,
  turns: 23,
  failedTurns: 1,
  checks: { passed: 9, total: 11 },
  guardrailHits: 2,
  tokens: 412_000,
};

/** 后台生成、正在试用的规则改动（0.108.0）。 */
export const trialProposal: TuningProposal = {
  ...ruleProposal,
  status: 'trial',
  origin: 'auto',
  version: profileVersionRef,
  stats: { sessions: 3 },
};

/** 试用后回退的记忆改动（0.108.0）。 */
export const revertedProposal: TuningProposal = {
  ...memoryProposal,
  edited: undefined,
  status: 'reverted',
  origin: 'agent',
  outcome: {
    decidedBy: 'auto',
    result: 'reverted',
    reason: 'worse',
    baseline: tuningMetrics,
    trial: { ...tuningMetrics, failedTurns: 6, checks: { passed: 4, total: 9 } },
    decidedAt: TS2,
  },
};

/** Host 按规则替用户允许（0.80.0）。 */
export const ruleResolution: ApprovalResolution = {
  optionId: 'allow-once',
  reason: 'rule',
  ruleIds: [ids.approvalRule],
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

/** 收件箱里的审批（0.105.0）。 */
export const inboxApproval: InboxItem = {
  id: `approval:${ids.approval}`,
  kind: 'approval',
  sessionId: ids.session,
  workspaceId: ids.workspace,
  title: '修登录页',
  summary: '/tmp/wevir-outside.txt',
  createdAt: TS,
  expiresAt: TS2,
  ref: { approvalId: ids.approval, turnId: ids.turn, options: pendingApproval.options },
};

/** 收件箱里的高风险审批（0.131.0）：删文件的命令。 */
export const inboxRiskyApproval: InboxItem = {
  ...inboxApproval,
  summary: 'rm -rf build',
  ref: {
    ...inboxApproval.ref,
    risk: { level: 'high', reasons: ['destructive_command', 'outside_sandbox'] },
  },
};

/** 收件箱里的问题（0.105.0）：子会话的，标出父会话。 */
export const inboxQuestion: InboxItem = {
  id: `question:${ids.question}`,
  kind: 'question',
  sessionId: ids.childSession,
  workspaceId: ids.workspace,
  parentSessionId: ids.session,
  title: '查依赖',
  summary: '这次改动做到哪一步？',
  createdAt: TS,
  ref: {
    questionId: ids.question,
    turnId: ids.turn,
    questions: [
      {
        id: 'scope',
        header: '范围',
        question: '这次改动做到哪一步？',
        options: [{ label: '只做界面' }, { label: '全链路' }],
        allowOther: true,
      },
    ],
  },
};

/** 收件箱里失败的回合与自动化运行（0.105.0）。 */
export const inboxTurnFailed: InboxItem = {
  id: `turn_failed:${ids.turn}`,
  kind: 'turn_failed',
  sessionId: ids.session,
  workspaceId: ids.workspace,
  title: '修登录页',
  summary: 'stream disconnected before completion',
  createdAt: TS2,
  ref: { turnId: ids.turn },
};

export const inboxAutomation: InboxItem = {
  id: `automation:${ids.automationRun}`,
  kind: 'automation',
  sessionId: ids.session,
  title: '每天看一眼 CI',
  summary: 'main 上的 e2e 挂了两次',
  createdAt: TS2,
  ref: { automationId: ids.automation, runId: ids.automationRun, status: 'completed' },
};

/** 通知意图（0.106.0）：会话里的审批与自动化运行等待处理。 */
export const approvalIntent: NotificationIntent = {
  id: `approval:${ids.approval}`,
  kind: 'approval',
  sessionId: ids.session,
  workspaceId: ids.workspace,
  title: '修登录页',
  body: '/tmp/wevir-outside.txt',
  createdAt: TS,
  collapseKey: `session:${ids.session}`,
};

export const automationIntent: NotificationIntent = {
  id: `automation:${ids.automationRun}:waiting`,
  kind: 'automation',
  sessionId: ids.session,
  workspaceId: ids.workspace,
  automationId: ids.automation,
  automationStatus: 'waiting',
  title: '每天看一眼 CI',
  body: '',
  createdAt: TS2,
  collapseKey: `session:${ids.session}`,
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
      // 0.72.0：推荐的选项。
      defaultOption: '全链路',
    },
    {
      id: 'targets',
      question: '要覆盖哪些平台？',
      options: [{ label: 'macOS' }, { label: 'Windows' }, { label: 'Linux' }],
      multiSelect: true,
      defaultOption: 'macOS',
    },
  ],
  status: 'pending',
  createdAt: TS,
  // 0.72.0：无人值守的会话里到时按推荐回答。
  autoAnswerAt: TS2,
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
  'session.moved': {
    valid: {
      to: 'worktree',
      from: '/Users/me/projects/wevir',
      cwd: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-wevir',
      branch: 'wevir/fix-login',
      ref: 'refs/wevir/move/ses_x/01JA2B3C4D5E6F7G8H9JKMNPQR',
      engine: 'resumed',
    },
    invalid: {
      to: 'remote',
      from: '/Users/me/projects/wevir',
      cwd: '/x',
      engine: 'resumed',
    },
  },
  'session.rules': {
    valid: {
      ...sessionRules,
      engineSessionId: 'claude-6a1e0c2f',
      bytes: 2048,
      // 0.78.0：用户的说明与输出风格。
      custom: {
        instructions: true,
        outputStyle: 'concise',
        // 0.95.0：交了写作风格档案。
        writingStyle: 'profile',
        bytes: 1024,
      },
      // 0.85.0：档案版本。
      profileVersion: profileVersionRef,
    },
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
  'session.auto_continue': {
    valid: { turnId: ids.turn, resumeAt: TS2 },
    invalid: { turnId: ids.turn },
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
      from: {
        sessionId: ids.opinionSession,
        kind: 'report',
        opinion: { opinionId: ids.opinion, note: '按第 1 条改' },
      },
      collaborationMode: 'plan',
    },
    invalid: { turnId: ids.turn, content: [], sentBy: identity },
  },
  'turn.started': {
    valid: { turnId: ids.turn, trigger: 'goal' },
    invalid: { turnId: ids.turn, trigger: 'plan' },
  },
  'turn.retrying': {
    valid: {
      turnId: ids.turn,
      attempt: 2,
      maxAttempts: 5,
      reason:
        'stream disconnected before completion: websocket closed by server before response.completed',
    },
    invalid: { turnId: ids.turn, attempt: 0 },
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
      images: [
        {
          type: 'image',
          imageId: ids.image,
          mimeType: 'image/png',
          size: 1843200,
          width: 1024,
          height: 1024,
        },
      ],
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
      // 0.72.0：超时，按推荐回答。
      resolution: {
        reason: 'timeout',
        answers: { scope: { answers: ['全链路'] }, targets: { answers: ['macOS'] } },
      },
    },
    invalid: { questionId: ids.question, status: 'answered', resolution: { reason: 'expired' } },
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
  'chapter.marked': {
    valid: { title: '实现', summary: '按计划改协议、Host 与桌面端', turnId: ids.turn },
    invalid: { title: '' },
  },
  'turn.wrap_up': {
    valid: {
      turnId: ids.turn,
      recap: '换算函数支持开尔文，测试全部通过。还没提交。',
      ask: '要提交吗？',
      actions: [
        { label: '提交', message: '提交这次改动。' },
        { label: '先不', message: '先不提交，我自己看一遍。' },
      ],
      blocked: true,
    },
    invalid: {
      turnId: ids.turn,
      recap: '已完成。',
      ask: '选哪个？',
      actions: [
        { label: 'A', message: 'a' },
        { label: 'B', message: 'b' },
        { label: 'C', message: 'c' },
      ],
    },
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
  'opinion.updated': {
    valid: { opinion: quotedOpinion },
    invalid: { opinion: { ...runningOpinion, status: 'done' } },
  },
  'insight.updated': {
    valid: { insight: openInsight },
    invalid: { insight: { ...openInsight, tag: 'fyi' } },
  },
  'review.findings': {
    valid: {
      origin: 'review',
      summary: '换算对负数有误，其余无问题。',
      findings: [
        {
          title: '负数温度换算错误',
          body: '负数换算差一度：`Math.round` 对 -0.5 取到 0。',
          priority: 1,
          confidence: 0.8,
          path: 'src/convert.ts',
          startLine: 12,
          endLine: 14,
          commentId: ids.reviewComment,
        },
        {
          title: '依赖的版本范围过宽',
          body: '',
          priority: 3,
          location: '/opt/other/package.json:4-4',
        },
      ],
      turnId: ids.turn,
    },
    invalid: { origin: 'tool', findings: [{ title: '', body: 'x' }] },
  },
  'guardrail.blocked': {
    valid: guardrailBlocked,
    invalid: { ...guardrailBlocked, guardrailId: 'arl_x' },
  },
  'hook.outcome': {
    valid: hookOutcome,
    invalid: { ...hookOutcome, action: '' },
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

const automationRunSilentSample: AutomationRun = {
  id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPR2',
  automationId: ids.automation,
  trigger: 'schedule',
  status: 'silent',
  startedAt: '2026-10-20T21:00:00.000Z',
  finishedAt: '2026-10-20T21:00:02.000Z',
  check: { decision: 'silent', exitCode: 1, durationMs: 1840, output: 'no new failures\n' },
};

const automationRunCheckFailedSample: AutomationRun = {
  id: 'arn_01JA2B3C4D5E6F7G8H9JKMNPR3',
  automationId: ids.automation,
  trigger: 'manual',
  status: 'failed',
  startedAt: '2026-10-20T22:00:00.000Z',
  finishedAt: '2026-10-20T22:01:00.000Z',
  error: 'The check timed out after 60 s.',
  check: {
    decision: 'failed',
    exitCode: null,
    timedOut: true,
    durationMs: 60_000,
    output: '…waiting',
    truncated: true,
    error: 'The check timed out after 60 s.',
  },
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

const automationCheckedSample: Automation = {
  ...automationSample,
  schedule: { kind: 'interval', minutes: 15 },
  newSessionEachRun: false,
  sessionId: ids.session,
  notify: 'changes',
  check: { command: 'gh pr checks 42', wake: 'output_changed', timeoutSeconds: 30 },
  enabled: false,
  autoPausedAt: '2026-10-20T22:01:00.000Z',
  lastRun: { ...automationRunSample, unchanged: true },
};

/** 发给助理的晨间简报（0.121.0）。 */
export const automationBriefSample: Automation = {
  ...automationSample,
  title: 'Morning brief',
  prompt: 'Say in two or three lines what matters today.',
  schedule: { kind: 'daily', time: '08:00' },
  channelId: ids.channel,
  brief: true,
  notify: 'never',
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
const builtinSkill = {
  id: 'builtin_skill-creator',
  name: 'skill-creator',
  description: 'Create and improve skills',
  source: 'wevir' as const,
  path: '/Applications/Wevir.app/Contents/Resources/prompts/skills/skill-creator/SKILL.md',
  enabled: true,
  builtin: true as const,
};
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
/** 0.74.0：只给一个项目、从 Claude Code 导入的连接器与从 Codex 导入的 skill。 */
const importedConnector = {
  ...connector,
  id: 'con_imported',
  name: 'supabase',
  workspaceId: ids.workspace,
  importedFrom: { app: 'claude' as const, path: '/Users/me/project/.mcp.json' },
};
const pluginList071 = {
  connectors: [connector, importedConnector],
  skills: [
    skill,
    {
      ...skill,
      id: 'skl_imported',
      name: 'imported-skill',
      source: 'user' as const,
      importedFrom: {
        app: 'codex' as const,
        path: '/Users/me/.codex/skills/imported-skill/SKILL.md',
      },
    },
  ],
};
/** 0.97.0：要 OAuth 登录的远程连接器。 */
const oauthConnector = {
  id: 'con_oauth',
  name: 'linear',
  config: {
    transport: 'http' as const,
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth' as const,
    oauth: { clientId: 'wevir-client', scopes: ['read'], clientSecret: true as const },
  },
  enabled: true,
  oauth: {
    status: 'signed_in' as const,
    issuer: 'https://mcp.linear.app',
    scopes: ['read'],
    expiresAt: '2026-10-21T12:00:00.000Z',
  },
};
const pluginList097 = {
  connectors: [
    connector,
    oauthConnector,
    {
      ...oauthConnector,
      id: 'con_oauth_2',
      name: 'notion',
      config: {
        transport: 'http' as const,
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth' as const,
      },
      oauth: { status: 'error' as const, error: 'denied' },
    },
  ],
  skills: [skill],
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

/** 0.74.0：用户从 Claude Code 导入的笔记。 */
const memoryImported: MemoryNote = {
  ...memoryNote,
  origin: {
    by: 'user',
    at: TS,
    importedFrom: {
      app: 'claude',
      path: '/Users/me/.claude/projects/-Users-me-shop/memory/invoice-cents.md',
    },
  },
  lastEdit: { by: 'user', at: TS },
};

/** 0.74.0：一次扫描 Claude Code 的结果。 */
const importScan = {
  app: 'claude' as const,
  found: true,
  home: '/Users/me/.claude',
  memories: [
    {
      key: 'mem:4f2a9c',
      path: '/Users/me/.claude/projects/-Users-me-shop/memory/invoice-cents.md',
      status: 'new' as const,
      recommended: true,
      project: '/Users/me/shop',
      name: 'invoice-cents',
      type: 'feedback' as const,
      description: 'Discounts are computed in integer cents',
      content: 'Compute discounts in integer cents.',
      scope: 'project' as const,
      workspaceId: ids.workspace,
    },
    {
      key: 'mem:77b0e1',
      path: '/Users/me/.claude/projects/-Users-me-old/memory/huge.md',
      status: 'new' as const,
      problem: 'too_large',
      recommended: false,
      project: '/Users/me/old',
      name: 'huge',
      type: 'reference' as const,
      description: 'Long notes',
      content: '',
      scope: 'global' as const,
    },
  ],
  connectors: [
    {
      key: 'con:91c3d0',
      path: '/Users/me/shop/.mcp.json',
      status: 'new' as const,
      recommended: true,
      project: '/Users/me/shop',
      name: 'supabase',
      config: {
        transport: 'http' as const,
        url: 'https://mcp.supabase.com/mcp',
        headers: { Authorization: true as const },
      },
      workspaceId: ids.workspace,
    },
    {
      key: 'con:0d5e7a',
      path: '/Users/me/.claude.json',
      status: 'exists' as const,
      problem: 'unsupported_transport',
      recommended: false,
      name: 'legacy',
    },
  ],
  skills: [
    {
      key: 'skl:5a1b2c',
      path: '/Users/me/.claude/skills/review/SKILL.md',
      status: 'same' as const,
      recommended: false,
      name: 'review',
      description: 'Review the current diff',
    },
  ],
  unsupported: [],
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

/** 会话全文搜索（0.77.0）。 */
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

/** 官方插件市场的索引（0.91.0；0.93.0 的条目字段）：Wevir 维护的插件，与一个已认证、搬自上游的 MCP。 */
export const marketIndex: WevirMarketIndex = {
  schemaVersion: 1,
  name: 'Wevir',
  generatedAt: '2026-10-21T08:00:00Z',
  sequence: 3,
  commit: '2333fc8d1e0b9a7c6f5e4d3c2b1a09f8e7d6c5b4',
  categories: [
    { id: 'productivity', name: { 'zh-CN': '效率', en: 'Productivity' } },
    { id: 'other', name: { 'zh-CN': '其他', en: 'Other' } },
  ],
  featured: [
    { id: 'popular', name: { 'zh-CN': '热门', en: 'Popular' }, entries: ['notes', 'tracker'] },
  ],
  entries: [
    {
      id: 'notes',
      kind: 'plugin',
      path: 'plugins/notes',
      name: 'Notes',
      version: '1.2.0',
      description: 'Take notes from the agent',
      i18n: {
        'zh-CN': {
          name: '笔记',
          description: '让 agent 记笔记',
          examples: ['把今天的会议要点记下来'],
        },
      },
      author: { name: 'Wevir' },
      license: 'MIT',
      icon: 'plugins/notes/icon.svg',
      category: 'productivity',
      keywords: ['notes'],
      listedAt: '2026-10-21T08:00:00Z',
      verification: { level: 'official', since: '2026-10' },
      examples: ["Write down the key points of today's meeting"],
      links: { privacy: 'https://example.com/privacy', terms: 'https://example.com/terms' },
      requires: { runtimes: ['node>=20'] },
      contents: {
        connectors: [
          {
            name: 'api',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@acme/notes-mcp@1.2.3'],
          },
        ],
        skills: [{ name: 'jot', description: 'Write a note' }],
        inputs: [{ key: 'TOKEN', label: 'Token', secret: true, required: true }],
      },
      files: [
        { path: 'wevir-plugin.json', size: 512, sha256: 'a'.repeat(64) },
        { path: 'README.md', size: 120, sha256: 'b'.repeat(64) },
      ],
      digest: 'c'.repeat(64),
      history: [{ version: '1.1.0', commit: 'd'.repeat(40) }],
    },
    {
      id: 'tracker',
      kind: 'mcp',
      path: 'plugins/tracker',
      name: 'Tracker',
      version: '2.4.1',
      category: 'other',
      listedAt: '2026-10-20T12:30:00Z',
      verification: {
        level: 'verified',
        publisher: 'Acme Inc.',
        since: '2026-10',
        note: { en: "Published from Acme's own repository" },
      },
      upstream: {
        url: 'https://github.com/acme/tracker-mcp',
        version: '2.4.0',
        commit: 'e'.repeat(40),
        license: 'Apache-2.0',
      },
      contents: {
        connectors: [{ name: 'tracker', transport: 'http', url: 'https://mcp.acme.example/mcp' }],
        skills: [],
        inputs: [],
      },
      files: [{ path: 'wevir-plugin.json', size: 300, sha256: 'f'.repeat(64) }],
      digest: '0'.repeat(64),
    },
  ],
};

/** 一个助理（0.120.0）。 */
export const channelSample: Channel = {
  id: ids.channel,
  kind: 'assistant',
  workspaceId: ids.workspace,
  title: '收件箱',
  assistant: {
    description: '每天整理邮件，挑出要回的',
    avatar: { type: 'clover', color: 2, seed: 0.42 },
    rules: { messages: 'ask', local_files: 'tell' },
    folders: [],
  },
  coordinator: {
    providerId: 'openai',
    modelId: 'gpt-5.5-mini',
    mode: 'act',
    sessionId: ids.coordinator,
    generation: 1,
  },
  budget: { dailyWakes: 20, dailyTokens: 200_000 },
  usage: { day: '2026-10-12', wakes: 3, tokens: 41_200 },
  state: 'waiting',
  pendingCount: 1,
  lastPostSeq: 4,
  lastPost: { seq: 4, author: 'coordinator', preview: '两封要回，草稿已备好。', at: TS2 },
  unreadCount: 2,
  createdAt: TS,
  updatedAt: TS2,
};

export const channelUserPost: ChannelPost = {
  id: ids.channelPost,
  channelId: ids.channel,
  seq: 3,
  author: { kind: 'user' },
  content: [{ type: 'text', text: '今天有什么要回的？' }],
  clientPostId: 'cp-1',
  createdAt: TS,
};

export const channelCoordinatorPost: ChannelPost = {
  id: ids.channelPost2,
  channelId: ids.channel,
  seq: 4,
  author: { kind: 'coordinator', sessionId: ids.coordinator, generation: 1 },
  content: [{ type: 'text', text: '两封要回，草稿已备好。' }],
  replyTo: ids.channelPost,
  card: {
    kind: 'needs',
    items: [
      { kind: 'connector', label: 'Gmail', ready: false },
      { kind: 'folder', label: '~/Documents', ready: true },
    ],
  },
  createdAt: TS2,
};

export const channelThread: ChannelThread = {
  sessionId: ids.session,
  channelId: ids.channel,
  rootPostId: ids.channelPost,
  title: '回复房东',
  status: 'working',
  doing: '起草回信',
  replyCount: 1,
  lastReply: { at: TS2, firstLine: '草稿在附件里。' },
  openedBy: 'coordinator',
  createdAt: TS,
};

const channelPostSamples: { valid: ChannelPost[]; invalid: unknown[] } = {
  valid: [
    channelUserPost,
    channelCoordinatorPost,
    {
      ...channelCoordinatorPost,
      card: { kind: 'suggestion', text: '每周五整理一次订阅邮件？', status: 'open' },
    },
    {
      ...channelCoordinatorPost,
      author: { kind: 'host' },
      card: {
        kind: 'brief',
        day: '2026-10-12',
        todo: [{ title: '回复房东' }],
        done: [{ title: '整理发票', sessionId: ids.session }],
        decisions: [],
      },
    },
    {
      ...channelCoordinatorPost,
      author: { kind: 'host' },
      card: { kind: 'notice', reason: 'budget' },
    },
    {
      ...channelCoordinatorPost,
      author: { kind: 'host' },
      content: [{ type: 'text', text: 'notes/today.md' }],
      card: { kind: 'notice', reason: 'acted', category: 'local_files' },
    },
    { ...channelUserPost, routedTo: [ids.session] },
  ],
  invalid: [
    { ...channelUserPost, seq: 0 },
    { ...channelUserPost, content: [] },
    { ...channelCoordinatorPost, card: { kind: 'needs', items: [] } },
    { ...channelUserPost, author: { kind: 'robot' } },
  ],
};

export const methodSamples: MethodSamples = {
  'plugins.list': {
    params: empty,
    result: {
      valid: [
        pluginList,
        pluginList042,
        pluginList071,
        { ...pluginList, skills: [skill, builtinSkill] },
        pluginList097,
      ],
      invalid: [
        { connectors: [] },
        { ...pluginList, skills: [{ ...builtinSkill, builtin: false }] },
        { ...pluginList097, connectors: [{ ...oauthConnector, oauth: { status: 'unknown' } }] },
        {
          ...pluginList097,
          connectors: [
            {
              ...oauthConnector,
              config: { ...oauthConnector.config, oauth: { clientSecret: 'must-not-return' } },
            },
          ],
        },
        { ...pluginList042, plugins: [{ ...plugin, source: 'npm' }] },
        { ...pluginList071, connectors: [{ ...importedConnector, workspaceId: 'project-1' }] },
        {
          ...pluginList071,
          connectors: [{ ...importedConnector, importedFrom: { app: 'cursor', path: '/x' } }],
        },
      ],
    },
  },
  'connector.login': {
    params: {
      valid: [
        { name: 'linear' },
        { name: 'docs', workspaceId: ids.workspace },
        { name: 'sample-plugin_api', pluginId: 'sample-plugin', scopes: ['read', 'write'] },
      ],
      invalid: [{}, { name: 'Linear' }, { name: 'linear', scopes: [''] }],
    },
    result: {
      valid: [{ loginId: 'login_1', authUrl: 'https://auth.example.com/authorize?state=abc' }],
      invalid: [{ loginId: 'login_1' }, { loginId: 'login_1', authUrl: 'javascript:alert(1)' }],
    },
  },
  'connector.loginCancel': {
    params: { valid: [{ loginId: 'login_1' }], invalid: [{}, { loginId: '' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'connector.logout': {
    params: {
      valid: [{ name: 'linear' }, { name: 'docs', workspaceId: ids.workspace }],
      invalid: [{}, { name: 'linear', workspaceId: 'project' }],
    },
    result: { valid: [{}], invalid: [null] },
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
        {
          name: 'project-db',
          config: { transport: 'stdio', command: 'npx', args: ['db-mcp'] },
          workspaceId: ids.workspace,
        },
        { name: 'linear', config: { transport: 'http', url: 'https://mcp.linear.app/mcp' } },
        {
          name: 'github',
          config: {
            transport: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            auth: 'oauth',
            oauth: {
              clientId: 'Iv1.sample',
              clientSecret: 'input-only',
              scopes: ['repo'],
              callbackPort: 33418,
              callbackUrl: 'http://127.0.0.1:33418/callback',
              resource: 'https://api.githubcopilot.com/mcp/',
              authorizeParams: { access_type: 'offline' },
            },
          },
        },
      ],
      invalid: [
        { name: 'wevir_bad', config: { transport: 'stdio', command: 'node' } },
        { name: 'x', config: { transport: 'http', url: 'https://a.example/mcp', auth: 'basic' } },
        {
          name: 'x',
          config: { transport: 'http', url: 'https://a.example/mcp', oauth: { callbackPort: 0 } },
        },
        {
          name: 'x',
          config: {
            transport: 'http',
            url: 'https://a.example/mcp',
            oauth: { authorizeParams: { redirect_uri: 'http://127.0.0.1/x' } },
          },
        },
        { name: 'x', config: { transport: 'stdio', command: 'node' }, workspaceId: 'ws-' },
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
        {
          id: oauthConnector.id,
          config: { transport: 'http', auth: null, oauth: { clientId: 'x', clientSecret: null } },
        },
        { id: oauthConnector.id, config: { transport: 'http', auth: 'oauth', oauth: null } },
      ],
      invalid: [{}, { id: oauthConnector.id, config: { transport: 'http', auth: 'basic' } }],
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
        // 0.98.0：权限执行，受限连接的实际权限。
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.98.0',
          minProtocolVersion: '0.1.0',
          features: { permission_enforcement: true },
          permissions: ['session.read', 'session.write', 'workspace.read'],
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
        // 0.78.0：给 Agent 的说明与输出风格。
        {
          settings: {
            sendWhileBusy: 'steer',
            agentInstructions: '回答用中文，代码注释用英文。',
            outputStyle: 'concise',
          },
        },
        // 0.79.0：你应该知道的开关。
        { settings: { sendWhileBusy: 'steer', sessionInsights: true } },
        // 0.95.0：参考我的写作风格。
        { settings: { sendWhileBusy: 'steer', writingStyle: true } },
        // 0.114.0：电脑操作。
        { settings: { sendWhileBusy: 'steer', computerUse: true } },
        // 0.122.0：iOS 模拟器。
        { settings: { sendWhileBusy: 'steer', iosSimulator: false } },
        // 0.102.0：运行时防止系统休眠。
        { settings: { sendWhileBusy: 'steer', preventSleep: true } },
        // 0.106.0：哪几类事产生通知意图。
        {
          settings: {
            sendWhileBusy: 'steer',
            notifications: { completed: false, automation: true },
          },
        },
        // 0.107.0：远程访问。
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: true, tailscale: false },
              relay: { enabled: true, url: 'wss://relay.example.com' },
              push: { enabled: false },
            },
          },
        },
        // 0.108.0：自动调优与每月上限。
        {
          settings: { sendWhileBusy: 'steer', autoTuning: true, autoTuningMonthlyTokens: 500_000 },
        },
        { settings: { sendWhileBusy: 'steer', autoTuning: false } },
        // 0.109.0：远程监听的端口与局域网网卡。
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: {
                lan: true,
                tailscale: true,
                lanInterfaces: [{ name: 'en0', family: 'IPv4' }],
              },
              port: 47_830,
              relay: { enabled: false },
              push: { enabled: false },
            },
          },
        },
        // 0.117.0：中继的三态与网页设备。
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: false, tailscale: false },
              relay: { enabled: true, mode: 'official', url: 'wss://relay.example.com' },
              push: { enabled: false },
              web: { url: 'https://example.com/wevir', idleDays: 0 },
            },
          },
        },
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: false, tailscale: false },
              relay: { enabled: true, mode: 'custom', url: 'wss://relay.example.com' },
              push: { enabled: false },
              web: { idleDays: 30 },
            },
          },
        },
      ],
      invalid: [
        { settings: { sendWhileBusy: 'interrupt' } },
        { settings: { sendWhileBusy: 'steer', promptSuggestions: 'yes' } },
        { settings: { sendWhileBusy: 'steer', sessionRecap: 'off' } },
        { settings: { sendWhileBusy: 'steer', autoMemory: 'off' } },
        { settings: { sendWhileBusy: 'steer', ruleFiles: 'on' } },
        { settings: { sendWhileBusy: 'steer', agentInstructions: 'x'.repeat(16_001) } },
        { settings: { sendWhileBusy: 'steer', outputStyle: '' } },
        { settings: { sendWhileBusy: 'steer', notifications: { completed: 'off' } } },
        { settings: { sendWhileBusy: 'steer', remote: { enabled: true } } },
        { settings: { sendWhileBusy: 'steer', autoTuningMonthlyTokens: 5_000 } },
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: true, tailscale: false },
              port: 80,
              relay: { enabled: false },
              push: { enabled: false },
            },
          },
        },
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: true, tailscale: false, lanInterfaces: [{ name: 'en0' }] },
              relay: { enabled: false },
              push: { enabled: false },
            },
          },
        },
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: false, tailscale: false },
              relay: { enabled: true, mode: 'wevir' },
              push: { enabled: false },
            },
          },
        },
        {
          settings: {
            sendWhileBusy: 'steer',
            remote: {
              enabled: true,
              interfaces: { lan: false, tailscale: false },
              relay: { enabled: false },
              push: { enabled: false },
              web: { url: 'http://example.com', idleDays: 3651 },
            },
          },
        },
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
        { settings: { agentInstructions: '' } },
        { settings: { outputStyle: 'friendly' } },
        { settings: { writingStyle: true } },
        { settings: { marketMirror: 'cnb' } },
        { settings: { marketMirror: 'auto' } },
        { settings: { preventSleep: true } },
        { settings: { notifications: { approval: true, question: false } } },
        { settings: { notifications: { agent: false } } },
        {
          settings: {
            remote: {
              enabled: false,
              interfaces: { lan: false, tailscale: false },
              relay: { enabled: false },
              push: { enabled: false },
            },
          },
        },
        // 0.108.0：引导里选了启用与上限。
        { settings: { autoTuning: true, autoTuningMonthlyTokens: 1_000_000 } },
        { settings: { autoTuning: false } },
        // 0.92.0：听写的转写方与润色
        { settings: { speechTranscriber: { kind: 'local' } } },
        {
          settings: {
            speechTranscriber: {
              kind: 'provider',
              providerId: 'groq',
              modelId: 'whisper-large-v3',
            },
            speechPolish: true,
          },
        },
        { settings: {} },
      ],
      invalid: [
        { settings: { speechTranscriber: { kind: 'cloud' } } },
        { settings: { speechTranscriber: { kind: 'provider', providerId: 'groq' } } },
        { settings: { speechPolish: 'yes' } },
        { settings: { preventSleep: 'on' } },
        { settings: { sendWhileBusy: 'later' } },
        { settings: { promptSuggestions: 0 } },
        { settings: { sessionRecap: 1 } },
        { settings: { autoMemory: 'no' } },
        { settings: { ruleFiles: 1 } },
        { settings: { outputStyle: 1 } },
        { settings: { writingStyle: 'on' } },
        { settings: { marketMirror: 'npm' } },
        { settings: { autoTuning: 'on' } },
        { settings: { autoTuningMonthlyTokens: 20_000_000 } },
        {},
      ],
    },
    result: {
      valid: [
        { settings: { sendWhileBusy: 'queue' } },
        { settings: { sendWhileBusy: 'queue', promptSuggestions: false } },
        {
          settings: {
            sendWhileBusy: 'steer',
            speechTranscriber: { kind: 'local' },
            speechPolish: false,
          },
        },
      ],
      invalid: [{ settings: {} }],
    },
  },
  'power.get': {
    params: empty,
    result: {
      valid: [{ keepAwake: true }, { keepAwake: false }],
      invalid: [{}, { keepAwake: 'yes' }],
    },
  },
  'market.status': {
    params: empty,
    result: {
      valid: [
        { preference: 'auto', mirror: 'cnb' },
        { preference: 'gitee', mirror: 'gitee' },
        { preference: 'auto' },
      ],
      invalid: [{ preference: 'fastest' }, { preference: 'auto', mirror: 'npm' }, {}],
    },
  },
  'market.index': {
    params: { valid: [{}, { refresh: true }], invalid: [{ refresh: 'yes' }] },
    result: {
      valid: [
        { index: marketIndex, mirror: 'github', fetchedAt: TS },
        { index: marketIndex, mirror: 'gitee', fetchedAt: TS, error: 'HTTP 503 from cnb' },
      ],
      invalid: [
        { index: marketIndex, fetchedAt: TS },
        { index: { ...marketIndex, sequence: 0 }, mirror: 'github', fetchedAt: TS },
        { index: { ...marketIndex, commit: 'main' }, mirror: 'github', fetchedAt: TS },
      ],
    },
  },
  'market.file': {
    params: {
      valid: [
        { entry: 'notes', path: 'README.md' },
        { entry: 'notes', path: 'assets/icon.svg' },
      ],
      invalid: [
        {},
        { entry: 'notes' },
        { entry: 'notes', path: '../keys/market.pub' },
        { entry: 'notes', path: '/etc/passwd' },
        { entry: 'Notes!', path: 'README.md' },
      ],
    },
    result: {
      valid: [{ data: 'IyBOb3Rlcwo=' }, { data: '' }],
      invalid: [{}, { data: 1 }],
    },
  },
  'market.install': {
    params: {
      valid: [
        { entry: 'notes' },
        { entry: 'notes', inputs: { TOKEN: 'input-only' }, replace: true },
      ],
      invalid: [{}, { entry: 'Notes!' }, { entry: 'notes', inputs: { 'bad-key': 'x' } }],
    },
    result: {
      valid: [{ plugin, ignored: [] }],
      invalid: [{ plugin }, {}],
    },
  },
  'market.installCancel': {
    params: { valid: [{ entry: 'notes' }], invalid: [{}, { entry: '' }] },
    result: empty,
  },
  'writingStyle.get': {
    params: empty,
    result: {
      valid: [{}, { profile: writingStyleProfile }],
      invalid: [
        { profile: { ...writingStyleProfile, content: '' } },
        { profile: { ...writingStyleProfile, updatedBy: 'someone' } },
      ],
    },
  },
  'writingStyle.update': {
    params: {
      valid: [
        { content: '# 写作风格\n\n句子短。' },
        { content: '句子短。', revision: writingStyleProfile.revision },
      ],
      invalid: [
        {},
        { content: '' },
        { content: 'x'.repeat(16_001) },
        { content: 'x', revision: '' },
      ],
    },
    result: {
      valid: [
        { profile: { ...writingStyleProfile, updatedBy: 'user' } },
        { profile: writingStyleProfile, conflict: true },
      ],
      invalid: [{}, { profile: writingStyleProfile, conflict: false }],
    },
  },
  'writingStyle.delete': {
    params: empty,
    result: empty,
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
      valid: [
        { environments: [] },
        { environments: [environment] },
        { environments: [environmentWithVariables] },
      ],
      invalid: [
        { environments: [{ ...environment, folders: [] }] },
        { environments: [{ ...environment, variables: [{ name: '1X', preview: '' }] }] },
      ],
    },
  },
  'environment.create': {
    params: {
      valid: [
        { name: '前后端一起改', folders: environment.folders },
        {
          name: '前后端一起改',
          folders: environment.folders,
          variables: [{ name: 'STRIPE_SECRET_KEY', value: 'sk_test_51abc' }],
        },
      ],
      invalid: [
        { name: '', folders: environment.folders },
        { name: 'x', folders: environment.folders, variables: [{ name: 'A-B', value: '1' }] },
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
        { environmentId: ids.environment, variables: [] },
        {
          environmentId: ids.environment,
          variables: [{ name: 'STRIPE_SECRET_KEY' }, { name: 'NODE_ENV', value: 'test' }],
        },
      ],
      invalid: [
        { environmentId: ids.workspace },
        { environmentId: ids.environment, folders: [] },
        { environmentId: ids.environment, variables: [{ name: 'A', value: 'x\u0000y' }] },
      ],
    },
    result: { valid: [{ environment }, { environment: environmentWithVariables }], invalid: [{}] },
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
  'workspace.officePdf': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: 'docs/report.docx' },
        { workspaceId: ids.workspace, sessionId: ids.session, path: 'deck.pptx' },
      ],
      invalid: [{ workspaceId: ids.workspace, path: '' }, { path: 'a.docx' }],
    },
    result: {
      valid: [
        {
          path: 'docs/report.docx',
          url: 'http://127.0.0.1:52811/files/Zm9vYmFy/3f2a9c.pdf',
          pageCount: 12,
          missingFonts: ['Calibri'],
          expiresAt: 1_760_003_600_000,
        },
        { path: 'deck.pptx', unavailable: 'engine_missing' },
        { path: 'broken.docx', unavailable: 'invalid_document', message: 'The file is damaged.' },
      ],
      invalid: [{ url: 'http://127.0.0.1:1/files/x/a.pdf' }, { path: 'a', pageCount: -1 }],
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
  'files.read': {
    params: {
      valid: [
        { workspaceId: ids.workspace, path: 'notes.md' },
        { sessionId: ids.session, path: 'build/app.zip', offset: 524_288, length: 524_288 },
        { workspaceId: ids.workspace, sessionId: ids.session, path: 'a.png', offset: 0 },
      ],
      invalid: [
        { path: 'notes.md' },
        { workspaceId: ids.workspace, path: '' },
        { workspaceId: ids.workspace, path: 'a', offset: -1 },
        { workspaceId: ids.workspace, path: 'a', length: 0 },
        { workspaceId: ids.workspace, path: 'a', length: 524_289 },
      ],
    },
    result: {
      valid: [
        {
          path: 'notes.md',
          data: 'IyBOb3Rlcwo=',
          mime: 'text/markdown; charset=utf-8',
          size: 8,
          offset: 0,
          eof: true,
          mtimeMs: 1_760_000_000_123.456,
        },
        {
          path: 'build/app.zip',
          data: '',
          mime: 'application/octet-stream',
          size: 524_288,
          offset: 524_288,
          eof: true,
          mtimeMs: 1_760_000_000_000,
        },
      ],
      invalid: [
        { path: 'a', data: '', mime: '', size: 0, offset: 0, eof: true, mtimeMs: 0 },
        { path: 'a', data: '', mime: 'text/plain', size: 0, offset: 0, mtimeMs: 0 },
      ],
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
        { providers: [devinProvider] },
        { providers: [copilotProvider] },
        { providers: [kiroProvider] },
        { providers: [{ ...compatibleProvider, imageModels: [{ id: 'gpt-image-2' }] }] },
      ],
      invalid: [
        { providers: [{ ...compatibleProvider, hasSecret: undefined }] },
        { providers: [{ ...compatibleProvider, imageModels: [{ id: '' }] }] },
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
        // 0.92.0：带转写模型
        {
          id: 'groq',
          kind: 'openai-compatible',
          displayName: 'Groq',
          api: 'openai-completions',
          baseURL: 'https://api.groq.com/openai/v1',
          models: [{ id: 'llama-3.3-70b-versatile' }],
          transcriptionModels: [{ id: 'whisper-large-v3-turbo', displayName: 'Whisper Turbo' }],
          defaultModelId: 'llama-3.3-70b-versatile',
        },
        {
          id: 'openai',
          kind: 'openai-compatible',
          displayName: 'OpenAI',
          api: 'openai-responses',
          baseURL: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-6.1' }],
          imageModels: [{ id: 'gpt-image-2', displayName: 'GPT Image 2' }],
          defaultModelId: 'gpt-6.1',
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
        // 转写模型要有 ID
        {
          id: 'groq',
          kind: 'openai-compatible',
          displayName: 'Groq',
          api: 'openai-completions',
          baseURL: 'https://api.groq.com/openai/v1',
          models: [{ id: 'llama-3.3-70b-versatile' }],
          transcriptionModels: [{ id: '' }],
          defaultModelId: 'llama-3.3-70b-versatile',
        },
        {
          id: 'openai',
          kind: 'openai-compatible',
          displayName: 'OpenAI',
          api: 'openai-responses',
          baseURL: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-6.1' }],
          imageModels: [{ id: '' }],
          defaultModelId: 'gpt-6.1',
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
      valid: [
        { provider: compatibleProvider, created: false },
        {
          provider: { ...compatibleProvider, transcriptionModels: [{ id: 'whisper-1' }] },
          created: true,
        },
        {
          provider: { ...compatibleProvider, imageModels: [{ id: 'gpt-image-2' }] },
          created: false,
        },
      ],
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
  'provider.discoverImageModels': {
    params: {
      valid: [
        { providerId: 'openai' },
        { baseURL: 'https://api.openai.com/v1', apiKey: 'placeholder-key' },
      ],
      invalid: [{ providerId: 42 }, { baseURL: 'file:///tmp/models' }, { apiKey: '' }],
    },
    result: {
      valid: [
        { ok: true, models: [] },
        { ok: true, models: [{ id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }] },
        { ok: false, models: [], reason: 'auth', httpStatus: 401 },
      ],
      invalid: [
        { ok: true },
        { ok: true, models: [{ id: '' }] },
        { ok: false, models: [], reason: 'nope' },
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
  'provider.prewarm': {
    params: {
      valid: [{ providerId: 'antigravity' }],
      invalid: [{}, { providerId: 'Antigravity' }],
    },
    result: empty,
  },
  'account.list': {
    params: empty,
    result: {
      valid: [
        { accounts: [signedInAccount, claudeAccount, antigravityInstalling, workbuddyAccount] },
        { accounts: [devinAccount] },
        { accounts: [copilotAccount, copilotSigningIn] },
        { accounts: [kiroAccount, kiroSigningIn, kiroSignedOut] },
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
        { kind: 'devin', refresh: true },
        { kind: 'copilot', refresh: true },
        { kind: 'kiro', refresh: true },
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
        // 0.141.0：Kiro 选登录方式。
        { kind: 'kiro', method: 'device_code', option: 'google' },
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
    params: {
      valid: [{ kind: 'opencode' }, { kind: 'opencode', id: 'opencode-ab12' }],
      invalid: [{}, { kind: 'gemini' }, { kind: 'opencode', id: '' }],
    },
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
        // 0.101.0：列表的版本与待处理数。
        {
          sessions: [{ ...session, pendingApprovalCount: 2, pendingQuestionCount: 1 }],
          listVersion: 1792368000000,
        },
        { sessions: [], listVersion: 0 },
        // 0.134.0：助理开在用户项目里的线程照常列出。
        {
          sessions: [{ ...session, channel: { channelId: ids.channel, role: 'thread' } }],
          listVersion: 1792368000001,
        },
      ],
      invalid: [
        { sessions: [{ ...session, lastSeq: -1 }] },
        { sessions: [], listVersion: -1 },
        { sessions: [], listVersion: 1.5 },
        { sessions: [{ ...session, pendingApprovalCount: 0 }] },
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
        {
          ...snapshot,
          opinions: [runningOpinion, { ...quotedOpinion, id: 'opn_01JA2B3C4D5E6F7G8H9JKMNPR1' }],
        },
        { session: opinionSession, pendingApprovals: [] },
        {
          ...snapshot,
          insights: [knownInsight, { ...openInsight, id: 'isg_01JA2B3C4D5E6F7G8H9JKMNPR1' }],
        },
      ],
      invalid: [
        { ...snapshot, opinions: [{ ...quotedOpinion, text: '' }] },
        { ...snapshot, insights: [{ ...openInsight, summary: '' }] },
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
  'session.move': {
    params: {
      valid: [
        { sessionId: ids.session, to: 'worktree' },
        { sessionId: ids.session, to: 'local' },
      ],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, to: 'cloud' }],
    },
    result: {
      valid: [
        {
          session,
          moved: {
            to: 'worktree',
            from: '/Users/me/projects/wevir',
            cwd: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-wevir',
            branch: 'wevir/fix-login',
            ref: 'refs/wevir/move/ses_x/01JA2B3C4D5E6F7G8H9JKMNPQR',
            engine: 'resumed',
          },
        },
        {
          session,
          moved: {
            to: 'local',
            from: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-wevir',
            cwd: '/Users/me/projects/wevir',
            branch: 'wevir/fix-login',
            previousBranch: 'main',
            ref: 'refs/wevir/move/ses_x/01JA2B3C4D5E6F7G8H9JKMNPR1',
            engine: 'handoff',
          },
        },
        {
          session,
          moved: {
            to: 'worktree',
            from: '/Users/me/projects/wevir',
            cwd: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/2-wevir',
            engine: 'handoff',
            sourceKept: true,
          },
        },
      ],
      invalid: [
        { session },
        { session, moved: { to: 'worktree', from: '', cwd: '/x', engine: 'resumed' } },
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
        // 0.90.0：粘贴进来的一大段单独一段，标 pasted。
        {
          sessionId: ids.session,
          content: [
            { type: 'text', text: '这段日志里为什么失败：' },
            { type: 'text', text: 'Error: ENOENT\n    at open (node:fs)', pasted: true },
          ],
          clientMessageId: 'msg-6',
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
  'session.setAutoContinue': {
    params: {
      valid: [
        { sessionId: ids.session, turnId: ids.turn, enabled: true },
        { sessionId: ids.session, turnId: ids.turn, enabled: false },
      ],
      invalid: [
        { sessionId: ids.session, enabled: true },
        { sessionId: ids.session, turnId: ids.turn },
      ],
    },
    result: {
      valid: [
        {
          session: {
            ...session,
            state: 'idle',
            activeTurn: undefined,
            autoContinue: { turnId: ids.turn, resumeAt: TS2 },
          },
        },
        {
          session: {
            ...session,
            state: 'idle',
            activeTurn: undefined,
            wrapUp: { turnId: ids.turn, recap: '测试全部通过。', ask: '要提交吗？', blocked: true },
          },
        },
      ],
      invalid: [
        { session: { ...session, autoContinue: { turnId: ids.turn } } },
        { session: { ...session, wrapUp: { turnId: ids.turn, recap: '', blocked: false } } },
      ],
    },
  },
  'session.continueWithModel': {
    params: {
      valid: [
        { sessionId: ids.session, turnId: ids.turn, providerId: 'claude' },
        {
          sessionId: ids.session,
          turnId: ids.turn,
          providerId: 'claude',
          modelId: 'claude-sonnet-5-5',
          reasoningEffort: 'high',
        },
        { sessionId: ids.session, turnId: ids.turn, modelId: 'gpt-5.5', reasoningEffort: null },
      ],
      invalid: [
        { sessionId: ids.session, providerId: 'claude' },
        { sessionId: ids.session, turnId: ids.turn, modelId: '' },
      ],
    },
    result: {
      valid: [{ session: { ...session, state: 'running' }, turnId: ids.turn }],
      invalid: [{ session: { ...session, state: 'running' } }],
    },
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
  'session.secondOpinion': {
    params: {
      valid: [
        { sessionId: ids.session, providerId: 'claude' },
        {
          sessionId: ids.session,
          providerId: 'claude',
          modelId: 'claude-opus-5-5',
          reasoningEffort: 'high',
          focus: '登录失败后的重试是否会重复提交',
        },
      ],
      invalid: [
        { sessionId: ids.session },
        { sessionId: ids.session, providerId: 'claude', focus: '   ' },
        { sessionId: ids.session, providerId: 'claude', focus: 'x'.repeat(2001) },
      ],
    },
    result: {
      valid: [{ opinion: runningOpinion, session: opinionSession }],
      invalid: [{ opinion: runningOpinion }],
    },
  },
  'session.quoteOpinion': {
    params: {
      valid: [
        { sessionId: ids.session, opinionId: ids.opinion },
        {
          sessionId: ids.session,
          opinionId: ids.opinion,
          note: '按第 1 条改',
          clientMessageId: 'msg-7',
          delivery: 'queue',
        },
      ],
      invalid: [
        { sessionId: ids.session, opinionId: ids.task },
        { sessionId: ids.session, opinionId: ids.opinion, note: '' },
      ],
    },
    result: {
      valid: [
        { turnId: ids.turn, seq: 12, opinion: quotedOpinion },
        { pendingId: ids.pending, seq: 13, opinion: quotedOpinion },
      ],
      invalid: [{ turnId: ids.turn, seq: 12 }],
    },
  },
  'session.respondInsight': {
    params: {
      valid: [
        { sessionId: ids.session, insightId: ids.insight, response: 'known' },
        { sessionId: ids.session, insightId: ids.insight, response: 'dismissed' },
      ],
      invalid: [
        { sessionId: ids.session, insightId: ids.insight },
        { sessionId: ids.session, insightId: ids.insight, response: 'expanded' },
        { sessionId: ids.session, insightId: ids.opinion, response: 'known' },
      ],
    },
    result: {
      valid: [{ insight: knownInsight }],
      invalid: [{ insight: { ...knownInsight, status: 'seen' } }, {}],
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
                {
                  workspaceId: ids.workspace,
                  branch: 'wevir/fix-login-3',
                  path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/3-api',
                  bytes: 0,
                  dirty: true,
                  missing: true,
                  archived: true,
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
        {
          session: { ...session, state: 'closed', archivedAt: TS2 },
          worktrees: [
            {
              workspaceId: ids.workspace,
              branch: 'wevir/fix-login',
              path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-app',
              status: 'archived',
              ref: 'refs/wevir/worktree-archive/ses_x/1',
            },
            {
              workspaceId: ids.workspace,
              branch: 'wevir/fix-login-2',
              path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/2-lib',
              status: 'kept',
              reason: 'too_many_untracked',
            },
          ],
        },
        {
          session: { ...session, state: 'closed' },
          worktrees: [
            {
              workspaceId: ids.workspace,
              branch: 'wevir/fix-login',
              path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/1-app',
              status: 'restored',
              reason: 'branch_moved',
              ref: 'refs/wevir/worktree-archive/ses_x/1',
            },
            {
              workspaceId: ids.workspace,
              branch: 'wevir/fix-login-2',
              path: '/Users/me/Library/Application Support/Wevir/worktrees/ses_x/2-lib',
              status: 'failed',
              reason: 'branch_checked_out',
              ref: 'refs/wevir/worktree-archive/ses_x/2',
              message: "fatal: 'wevir/fix-login-2' is already used by worktree at '/tmp/x'",
            },
          ],
        },
      ],
      invalid: [
        { session: { ...session, archivedAt: 1 } },
        {
          session,
          worktrees: [{ workspaceId: ids.workspace, branch: 'b', path: '/x', status: 'deleted' }],
        },
      ],
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
        { note: memoryImported },
        // 0.87.0：采纳建议写下的。
        {
          note: {
            ...memoryNote,
            origin: {
              by: 'user',
              at: TS,
              sessionId: ids.session,
              proposalId: ids.tuningProposal,
              status: 'available',
            },
          },
        },
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
        {
          note: {
            ...memoryImported,
            origin: { by: 'user', at: TS, importedFrom: { app: 'claude' } },
          },
        },
      ],
    },
  },
  'import.scan': {
    params: {
      valid: [{ app: 'claude' }, { app: 'codex' }, { app: 'grok' }, { app: 'antigravity' }],
      invalid: [{}, { app: 'cursor' }],
    },
    result: {
      valid: [
        importScan,
        {
          app: 'grok',
          found: false,
          home: '/Users/me/.grok',
          memories: [],
          connectors: [],
          skills: [],
          unsupported: ['memory', 'connector'],
        },
      ],
      invalid: [
        { ...importScan, unsupported: ['rules'] },
        { ...importScan, memories: [{ ...importScan.memories[0], status: 'conflict' }] },
        { ...importScan, memories: [{ ...importScan.memories[0], name: 'Invoice Cents' }] },
        { ...importScan, home: '' },
      ],
    },
  },
  'import.apply': {
    params: {
      valid: [
        { app: 'claude', items: [{ key: 'mem:4f2a9c' }] },
        {
          app: 'claude',
          items: [
            { key: 'mem:4f2a9c', scope: 'global', name: 'invoice-cents-2' },
            { key: 'con:91c3d0', workspaceId: ids.workspace },
            { key: 'skl:5a1b2c' },
          ],
        },
      ],
      invalid: [
        { app: 'claude', items: [] },
        { app: 'claude', items: [{ key: '' }] },
        { app: 'claude', items: [{ key: 'mem:1', workspaceId: 'ws' }] },
        { items: [{ key: 'mem:1' }] },
      ],
    },
    result: {
      valid: [
        {
          results: [
            { key: 'mem:4f2a9c', outcome: 'imported', kind: 'memory', name: 'invoice-cents' },
            { key: 'skl:5a1b2c', outcome: 'skipped', kind: 'skill', name: 'review' },
            { key: 'con:0d5e7a', outcome: 'failed', kind: 'connector', reason: 'exists' },
            { key: 'mem:gone', outcome: 'failed', reason: 'not_found' },
          ],
        },
        { results: [] },
      ],
      invalid: [{}, { results: [{ key: 'mem:1', outcome: 'done' }] }],
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
  'retro.get': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, redact: true }],
      invalid: [{}, { sessionId: ids.session, redact: 'yes' }],
    },
    result: {
      valid: [
        { retro: sessionRetro },
        { retro: { ...sessionRetro, summary: { ...retroSummary, outdated: true } }, redactions: 2 },
      ],
      invalid: [
        {},
        { retro: { ...sessionRetro, build: 'partial' } },
        { retro: { ...sessionRetro, chapters: [{ id: 'h4', text: '实现', turns: -1 }] } },
      ],
    },
  },
  'retro.summarize': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: {
      valid: [{ summary: retroSummary }, { reason: 'unsupported' }],
      invalid: [{ summary: { ...retroSummary, points: [] } }],
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
      valid: [
        { comments: [] },
        { comments: [reviewComment, sentReviewComment] },
        { comments: [findingComment] },
      ],
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
      valid: [{ processes: [] }, { processes: [agentProcess, checkProcess, previewProcess] }],
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
  'preview.list': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}, { sessionId: ids.workspace }] },
    result: {
      valid: [
        { root: '/home/u/projects/demo', configs: [], candidates: [] },
        {
          root: '/home/u/projects/demo',
          configs: [
            previewConfig,
            {
              ...previewConfig,
              name: 'api',
              addedBy: 'agent',
              port: undefined,
              url: 'http://127.0.0.1:8787/health',
              env: { NODE_ENV: 'development' },
            },
          ],
          candidates: [
            previewCandidate,
            { ...previewCandidate, origin: 'claude_launch', file: '.claude/launch.json' },
          ],
        },
      ],
      invalid: [
        {
          root: '/home/u/projects/demo',
          configs: [{ ...previewConfig, addedBy: 'someone' }],
          candidates: [],
        },
        {
          root: '/home/u/projects/demo',
          configs: [{ ...previewConfig, url: 'ftp://x' }],
          candidates: [],
        },
      ],
    },
  },
  'preview.save': {
    params: {
      valid: [
        { workspaceId: ids.workspace, config: { name: 'web', command: 'pnpm run dev' } },
        {
          workspaceId: ids.workspace,
          config: { name: 'web2', command: 'pnpm run dev', cwd: 'apps/web', port: 5174 },
          previous: 'web',
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, config: { name: '', command: 'pnpm run dev' } },
        { workspaceId: ids.workspace, config: { name: 'web', command: 'x', port: 70000 } },
        {
          workspaceId: ids.workspace,
          config: { name: 'web', command: 'x', env: { 'BAD-NAME': '1' } },
        },
      ],
    },
    result: { valid: [{ configs: [previewConfig] }], invalid: [{}] },
  },
  'preview.remove': {
    params: {
      valid: [{ workspaceId: ids.workspace, name: 'web' }],
      invalid: [{ workspaceId: ids.workspace }],
    },
    result: { valid: [{ configs: [] }], invalid: [{ configs: [{ name: 'web' }] }] },
  },
  'preview.start': {
    params: {
      valid: [{ sessionId: ids.session, name: 'web' }],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, name: '' }],
    },
    result: {
      valid: [
        {
          status: 'started',
          process: {
            ...previewProcess,
            preview: {
              ...(previewProcess.preview as NonNullable<HostProcess['preview']>),
              ready: false,
            },
          },
        },
        { status: 'reused', process: previewProcess },
        {
          status: 'blocked',
          readiness: [
            {
              kind: 'dependencies',
              name: 'node_modules',
              path: 'apps/web',
              status: 'missing',
              reason: 'not_installed',
            },
          ],
        },
        { status: 'port_in_use', port: 5173, url: 'http://localhost:5173' },
      ],
      invalid: [
        { status: 'blocked', readiness: [] },
        { status: 'failed' },
        { status: 'port_in_use', port: 0, url: 'http://localhost' },
      ],
    },
  },
  'readiness.get': {
    params: {
      valid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, sessionId: ids.session, refresh: true },
      ],
      invalid: [{}, { workspaceId: ids.session }],
    },
    result: {
      valid: [{ report: readinessReport }],
      invalid: [{ report: { ...readinessReport, status: 'partly' } }],
    },
  },
  'readiness.install': {
    params: {
      valid: [
        { workspaceId: ids.workspace, planId: 'pln_5c2a91e0', acceptScripts: true },
        {
          workspaceId: ids.workspace,
          sessionId: ids.session,
          planId: 'pln_5c2a91e0',
          acceptScripts: true,
          timeoutMs: 600_000,
        },
      ],
      invalid: [
        { workspaceId: ids.workspace, planId: 'pln_5c2a91e0' },
        { workspaceId: ids.workspace, planId: 'pln_5c2a91e0', acceptScripts: false },
      ],
    },
    result: {
      valid: [{ run: { ...installRun, status: 'running', reason: undefined } }],
      invalid: [{ run: { ...installRun, status: 'done' } }],
    },
  },
  'readiness.cancel': {
    params: { valid: [{ runId: ids.installRun }], invalid: [{ runId: ids.session }] },
    result: {
      valid: [{ run: { ...installRun, status: 'cancelled', reason: 'user' } }],
      invalid: [{}],
    },
  },
  'readiness.output': {
    params: {
      valid: [{ runId: ids.installRun }, { runId: ids.installRun, offset: 128 }],
      invalid: [{ runId: ids.installRun, offset: -1 }],
    },
    result: {
      valid: [{ text: 'Progress: resolved 12', from: 0, next: 21, more: false, bytes: 21 }],
      invalid: [{ text: '' }],
    },
  },
  'readiness.setCredential': {
    params: {
      valid: [
        { workspaceId: ids.workspace, name: 'NPM_TOKEN', value: 'npm_xxx' },
        { workspaceId: ids.workspace, name: 'NPM_TOKEN' },
      ],
      invalid: [
        { workspaceId: ids.workspace, name: 'NPM TOKEN', value: 'x' },
        { workspaceId: ids.workspace, name: 'NPM_TOKEN', value: '' },
      ],
    },
    result: {
      valid: [{ credentials: [] }, { credentials: ['NPM_TOKEN'] }],
      invalid: [{ credentials: ['1BAD'] }],
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
  'simulator.list': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { devices: [], deviceTypes: [], runtimes: [] },
        {
          devices: [simulatorDeviceSample, simulatorShutdownSample],
          deviceTypes: [
            {
              id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
              name: 'iPhone 17 Pro',
              family: 'iphone',
            },
          ],
          runtimes: [
            {
              id: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
              name: 'iOS 26.5',
              platform: 'ios',
              version: '26.5',
              available: true,
            },
          ],
        },
      ],
      invalid: [
        { devices: [{ ...simulatorDeviceSample, state: 'paused' }], deviceTypes: [], runtimes: [] },
      ],
    },
  },
  'simulator.boot': {
    params: { valid: [{ udid: simulatorDeviceSample.udid }], invalid: [{}, { udid: '' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'simulator.shutdown': {
    params: { valid: [{ udid: simulatorDeviceSample.udid }], invalid: [{ udid: 'a b' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'simulator.create': {
    params: {
      valid: [
        {
          name: 'iPhone 17 Pro (2)',
          deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        },
      ],
      invalid: [{ name: '', deviceTypeId: 'x', runtimeId: 'y' }],
    },
    result: {
      valid: [{ device: { ...simulatorDeviceSample, state: 'shutdown', attachedBy: [] } }],
      invalid: [{}],
    },
  },
  'simulator.attach': {
    params: {
      valid: [
        { udid: simulatorDeviceSample.udid },
        { udid: simulatorDeviceSample.udid, sessionId: ids.session },
      ],
      invalid: [{ udid: simulatorDeviceSample.udid, sessionId: 'p3' }],
    },
    result: {
      valid: [
        {
          streamUrl: 'ws://127.0.0.1:52100/simulator/stream?token=c2ltdG9rZW4',
          token: 'c2ltdG9rZW4',
          screen: { width: 402, height: 874, scale: 3 },
          orientation: 'portrait',
        },
      ],
      invalid: [
        {
          streamUrl: 'ws://127.0.0.1:52100/simulator/stream?token=x',
          token: 'x',
          screen: { width: 0, height: 874, scale: 3 },
          orientation: 'portrait',
        },
      ],
    },
  },
  'simulator.detach': {
    params: { valid: [{ udid: simulatorDeviceSample.udid }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'simulator.input': {
    params: {
      valid: [
        { udid: simulatorDeviceSample.udid, input: { type: 'tap', x: 201, y: 437 } },
        { udid: simulatorDeviceSample.udid, input: { type: 'tap', x: 201, y: 437, duration: 1 } },
        {
          udid: simulatorDeviceSample.udid,
          input: {
            type: 'touch',
            points: [
              { x: 200, y: 700, dtMs: 0 },
              { x: 200, y: 200, dtMs: 300 },
            ],
          },
        },
        {
          udid: simulatorDeviceSample.udid,
          input: { type: 'touch', points2: [{ x1: 150, y1: 400, x2: 250, y2: 400, dtMs: 0 }] },
        },
        {
          udid: simulatorDeviceSample.udid,
          input: { type: 'touch_raw', phase: 'down', x: 10, y: 20, finger: 1 },
        },
        { udid: simulatorDeviceSample.udid, input: { type: 'text', text: 'héllo 世界' } },
        { udid: simulatorDeviceSample.udid, input: { type: 'key', key: 'return', count: 2 } },
        { udid: simulatorDeviceSample.udid, input: { type: 'button', name: 'HOME' } },
        { udid: simulatorDeviceSample.udid, input: { type: 'rotate', direction: 'right' } },
      ],
      invalid: [
        { udid: simulatorDeviceSample.udid, input: { type: 'swipe' } },
        { udid: simulatorDeviceSample.udid, input: { type: 'key', key: 'f13' } },
        { udid: simulatorDeviceSample.udid, input: { type: 'text', text: '' } },
      ],
    },
    result: {
      valid: [{}, { orientation: 'landscapeRight' }],
      invalid: [{ orientation: 'sideways' }],
    },
  },
  'simulator.screenshot': {
    params: {
      valid: [
        { udid: simulatorDeviceSample.udid },
        {
          udid: simulatorDeviceSample.udid,
          format: 'jpeg',
          quality: 0.8,
          scale: 3,
          path: '/Users/u/Desktop/shot.jpg',
        },
      ],
      invalid: [{ udid: simulatorDeviceSample.udid, format: 'gif' }],
    },
    result: {
      valid: [
        { data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 402, height: 874 },
        { path: '/Users/u/Desktop/shot.jpg', mimeType: 'image/jpeg', width: 1206, height: 2622 },
      ],
      invalid: [{ data: 'x', mimeType: 'image/gif', width: 1, height: 1 }],
    },
  },
  'simulator.record.start': {
    params: { valid: [{ udid: simulatorDeviceSample.udid }], invalid: [{}] },
    result: { valid: [{ recordingId: `rec_${ULID}` }], invalid: [{ recordingId: 'r1' }] },
  },
  'simulator.record.stop': {
    params: { valid: [{ recordingId: `rec_${ULID}` }], invalid: [{ recordingId: ids.session }] },
    result: {
      valid: [{ path: '/tmp/wevir-sim/rec_1.mp4', durationMs: 4200 }],
      invalid: [{ path: '/tmp/x.mp4', durationMs: -1 }],
    },
  },
  'simulator.configure': {
    params: {
      valid: [
        { udid: simulatorDeviceSample.udid },
        {
          udid: simulatorDeviceSample.udid,
          appearance: 'dark',
          statusBar: 'clean',
          slowAnimations: false,
          hardwareKeyboard: true,
          softwareKeyboard: 'show',
        },
      ],
      invalid: [{ udid: simulatorDeviceSample.udid, appearance: 'sepia' }],
    },
    result: { valid: [{}], invalid: [null] },
  },
  'simulator.clipboard.get': {
    params: { valid: [{ udid: simulatorDeviceSample.udid }], invalid: [{}] },
    result: { valid: [{ text: '' }, { text: 'copied' }], invalid: [{}] },
  },
  'simulator.clipboard.set': {
    params: {
      valid: [{ udid: simulatorDeviceSample.udid, text: 'paste me' }],
      invalid: [{ udid: simulatorDeviceSample.udid }],
    },
    result: { valid: [{}], invalid: [null] },
  },
  'lsp.status': {
    params: {
      valid: [
        { workspaceId: ids.workspace },
        { workspaceId: ids.workspace, sessionId: ids.session, refresh: true },
      ],
      invalid: [{}, { workspaceId: ids.session }],
    },
    result: {
      valid: [
        { dir: '/home/u/projects/demo', servers: [] },
        {
          dir: '/home/u/projects/demo',
          servers: [
            lspRunningSample,
            lspMissingSample,
            {
              ...lspMissingSample,
              serverId: 'rust',
              language: 'Rust',
              state: 'failed',
              reason: 'rust-analyzer exited (code 101).',
              failures: 3,
              retryAt: TS2,
              plans: undefined,
            },
          ],
          truncated: true,
        },
      ],
      invalid: [
        { servers: [] },
        { dir: '/x', servers: [{ ...lspMissingSample, state: 'broken' }] },
      ],
    },
  },
  'lsp.restart': {
    params: {
      valid: [
        { workspaceId: ids.workspace, serverId: 'typescript', root: '/home/u/projects/demo' },
      ],
      invalid: [{ workspaceId: ids.workspace, serverId: 'typescript' }],
    },
    result: {
      valid: [{ server: lspRunningSample }],
      invalid: [{ server: { ...lspRunningSample, source: 'global' } }],
    },
  },
  'lsp.log': {
    params: {
      valid: [{ workspaceId: ids.workspace, serverId: 'go', root: '/home/u/projects/demo/tool' }],
      invalid: [{ workspaceId: ids.workspace, root: '/x' }],
    },
    result: {
      valid: [{ log: '' }, { log: '2026-10-20T00:00:00.000Z start: gopls in /x' }],
      invalid: [{}],
    },
  },
  'lsp.install': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          serverId: 'go',
          root: '/home/u/projects/demo/tool',
          planId: 'user-go',
          confirmGlobal: true,
        },
      ],
      invalid: [{ workspaceId: ids.workspace, serverId: 'go', root: '/x' }],
    },
    result: {
      valid: [
        { run: lspInstallSample },
        {
          run: {
            ...lspInstallSample,
            status: 'running',
            endedAt: undefined,
            exitCode: undefined,
            verification: undefined,
          },
        },
      ],
      invalid: [{ run: { ...lspInstallSample, status: 'done' } }],
    },
  },
  'lsp.cancelInstall': {
    params: { valid: [{ installId: lspInstallSample.id }], invalid: [{ installId: 'p3' }] },
    result: {
      valid: [{ run: { ...lspInstallSample, status: 'cancelled', reason: 'Cancelled.' } }],
      invalid: [{}],
    },
  },
  'automation.list': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { automations: [] },
        { automations: [automationSample, automationCheckedSample] },
        { automations: [automationBriefSample] },
      ],
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
        {
          automation: automationCheckedSample,
          runs: [automationRunCheckFailedSample, automationRunSilentSample],
        },
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
        {
          title: 'Morning brief',
          prompt: 'Say in two or three lines what matters today.',
          schedule: { kind: 'daily', time: '08:00' },
          channelId: ids.channel,
          brief: true,
        },
        {
          title: 'CI 状态',
          prompt: '看一下 CI 失败的原因。',
          schedule: { kind: 'interval', minutes: 10 },
          sessionId: ids.session,
          notify: 'changes',
          check: { command: 'gh pr checks 42', wake: 'output_changed' },
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
        { title: 'x', prompt: 'y', schedule: { kind: 'manual' }, providerId: '' },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'manual' },
          providerId: 'deepseek',
          check: { command: 'true', wake: 'exit_zero' },
        },
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'manual' },
          providerId: 'deepseek',
          check: { command: '  ', wake: 'exit_code' },
        },
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
        { automationId: ids.automation, sessionId: null, check: null },
        { automationId: ids.automation, brief: false },
        {
          automationId: ids.automation,
          sessionId: ids.session,
          check: { command: './scripts/has-news.sh', wake: 'exit_code', timeoutSeconds: 600 },
        },
      ],
      invalid: [
        {},
        { automationId: ids.automation, title: '' },
        { automationId: ids.automation, permissionMode: 'yolo' },
        {
          automationId: ids.automation,
          check: { command: 'x', wake: 'exit_code', timeoutSeconds: 601 },
        },
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
  'automation.testCheck': {
    params: {
      valid: [
        { check: { command: 'gh pr checks 42', wake: 'output_changed' } },
        {
          check: { command: 'git status --short', wake: 'output_changed' },
          sessionId: ids.session,
        },
        {
          check: { command: './check.sh', wake: 'exit_code', timeoutSeconds: 5 },
          workspaceId: ids.workspace,
          automationId: ids.automation,
        },
      ],
      invalid: [{}, { check: { command: 'x' } }],
    },
    result: {
      valid: [
        { result: automationRunSilentSample.check as AutomationCheckResult },
        { result: automationRunCheckFailedSample.check as AutomationCheckResult },
        { result: { decision: 'wake', exitCode: 0, durationMs: 12, output: '' } },
      ],
      invalid: [{ result: { decision: 'maybe', exitCode: 0, durationMs: 0, output: '' } }],
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
  'inbox.list': {
    params: empty,
    result: {
      valid: [
        {
          items: [inboxAutomation, inboxTurnFailed, inboxQuestion, inboxApproval],
          inboxVersion: 1792368000000,
        },
        { items: [], inboxVersion: 0 },
        { items: [{ ...inboxApproval, channelId: ids.channel }], inboxVersion: 2 },
        { items: [inboxRiskyApproval], inboxVersion: 3 },
      ],
      invalid: [
        { items: [] },
        {
          items: [
            {
              ...inboxApproval,
              ref: { ...inboxApproval.ref, risk: { level: 'low', reasons: ['x'] } },
            },
          ],
          inboxVersion: 1,
        },
        {
          items: [
            {
              ...inboxApproval,
              ref: { ...inboxApproval.ref, risk: { level: 'high', reasons: [] } },
            },
          ],
          inboxVersion: 1,
        },
        { items: [{ ...inboxApproval, summary: 'x'.repeat(301) }], inboxVersion: 1 },
        { items: [{ ...inboxApproval, ref: { turnId: ids.turn } }], inboxVersion: 1 },
        {
          items: [{ ...inboxAutomation, ref: { ...inboxAutomation.ref, status: 'waiting' } }],
          inboxVersion: 1,
        },
      ],
    },
  },
  'channel.list': {
    params: { valid: [{}, { kind: 'assistant' }], invalid: [{ kind: 'team' }] },
    result: {
      valid: [
        { channels: [channelSample], listVersion: 7 },
        { channels: [], listVersion: 0 },
        {
          channels: [
            {
              ...channelSample,
              state: 'paused',
              pausedAt: TS2,
              pauseReason: 'budget',
              pendingCount: undefined,
            },
          ],
          listVersion: 8,
        },
      ],
      invalid: [
        { channels: [] },
        { channels: [{ ...channelSample, state: 'busy' }], listVersion: 1 },
        {
          channels: [
            {
              ...channelSample,
              assistant: { ...channelSample.assistant, avatar: { type: 'cat', color: 0, seed: 0 } },
            },
          ],
          listVersion: 1,
        },
      ],
    },
  },
  'channel.get': {
    params: { valid: [{ channelId: ids.channel }], invalid: [{}, { channelId: ids.session }] },
    result: {
      valid: [
        {
          channel: channelSample,
          threads: [channelThread],
          approvals: [{ ...pendingApproval, sessionId: ids.coordinator }],
          tasks: [boardTask],
        },
        { channel: channelSample, threads: [], approvals: [], tasks: [] },
      ],
      invalid: [
        { channel: channelSample },
        { channel: channelSample, threads: [{}], approvals: [], tasks: [] },
      ],
    },
  },
  'channel.create': {
    params: {
      valid: [
        {
          kind: 'assistant',
          name: '收件箱',
          description: '每天整理邮件',
          coordinator: { providerId: 'openai' },
        },
        {
          kind: 'assistant',
          name: 'Research',
          description: '',
          avatar: { type: 'cloud', color: 5, seed: 1 },
          coordinator: { providerId: 'openai', modelId: 'gpt-5.5-mini', reasoningEffort: 'low' },
          folders: ['/Users/me/notes'],
          rules: { messages: 'ask' },
          budget: { dailyWakes: 10, dailyTokens: 100_000 },
        },
      ],
      invalid: [
        { kind: 'project', name: 'x', description: '', coordinator: { providerId: 'openai' } },
        { kind: 'assistant', name: '', description: '', coordinator: { providerId: 'openai' } },
        { kind: 'assistant', name: 'x', description: '', coordinator: {} },
        {
          kind: 'assistant',
          name: 'x',
          description: '',
          coordinator: { providerId: 'openai' },
          rules: { messages: 'never' },
        },
      ],
    },
    result: { valid: [{ channel: channelSample }], invalid: [{}] },
  },
  'channel.update': {
    params: {
      valid: [
        { channelId: ids.channel },
        { channelId: ids.channel, name: '邮件', paused: true },
        {
          channelId: ids.channel,
          coordinator: { modelId: null },
          rules: { purchases: 'hand_off' },
        },
      ],
      invalid: [
        { name: 'x' },
        { channelId: ids.channel, budget: { dailyWakes: 0, dailyTokens: 1000 } },
      ],
    },
    result: { valid: [{ channel: channelSample }], invalid: [{}] },
  },
  'channel.delete': {
    params: { valid: [{ channelId: ids.channel }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'channel.posts': {
    params: {
      valid: [
        { channelId: ids.channel },
        { channelId: ids.channel, beforeSeq: 40, limit: 50 },
        { channelId: ids.channel, afterSeq: 0 },
      ],
      invalid: [
        { channelId: ids.channel, limit: 201 },
        { channelId: ids.channel, beforeSeq: 0 },
      ],
    },
    result: {
      valid: [
        { posts: [channelUserPost, channelCoordinatorPost], lastSeq: 4 },
        { posts: [], lastSeq: 0 },
      ],
      invalid: [{ posts: [] }, { posts: channelPostSamples.invalid, lastSeq: 4 }],
    },
  },
  'channel.subscribe': {
    params: {
      valid: [{ channelId: ids.channel }, { channelId: ids.channel, afterSeq: 3 }],
      invalid: [{}, { channelId: ids.channel, afterSeq: -1 }],
    },
    result: {
      valid: [{ subscriptionId: ids.subscription, lastSeq: 4 }],
      invalid: [{ lastSeq: 4 }],
    },
  },
  'channel.unsubscribe': {
    params: { valid: [{ subscriptionId: ids.subscription }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'channel.post': {
    params: {
      valid: [
        { channelId: ids.channel, content: [{ type: 'text', text: '在吗' }] },
        {
          channelId: ids.channel,
          content: [{ type: 'image', imageId: ids.image, mimeType: 'image/png', size: 2048 }],
          clientPostId: 'cp-2',
        },
      ],
      invalid: [
        { channelId: ids.channel, content: [] },
        { content: [{ type: 'text', text: 'x' }] },
      ],
    },
    result: { valid: [{ post: channelUserPost }], invalid: [{}] },
  },
  'channel.markRead': {
    params: { valid: [{ channelId: ids.channel, seq: 4 }], invalid: [{ channelId: ids.channel }] },
    result: { valid: [{}], invalid: [null] },
  },
  'channel.startThread': {
    params: {
      valid: [
        { channelId: ids.channel, rootPostId: ids.channelPost },
        { channelId: ids.channel, rootPostId: ids.channelPost, title: '回复房东' },
      ],
      invalid: [{ channelId: ids.channel }, { channelId: ids.channel, rootPostId: ids.session }],
    },
    result: {
      // 0.134.0：开在用户项目里的线程带 workspaceId。
      valid: [
        { thread: channelThread },
        { thread: { ...channelThread, workspaceId: ids.workspace } },
      ],
      invalid: [
        { thread: { ...channelThread, status: 'busy' } },
        { thread: { ...channelThread, workspaceId: 'ws_' } },
      ],
    },
  },
  'channel.resolveThread': {
    params: {
      valid: [{ channelId: ids.channel, sessionId: ids.session, resolved: true }],
      invalid: [{ channelId: ids.channel, sessionId: ids.session }],
    },
    result: {
      valid: [
        { thread: { ...channelThread, status: 'resolved', resolvedAt: TS2, resolvedBy: 'user' } },
      ],
      invalid: [{}],
    },
  },
  'channel.respondSuggestion': {
    params: {
      valid: [{ channelId: ids.channel, postId: ids.channelPost2, accept: true }],
      invalid: [{ channelId: ids.channel, postId: ids.channelPost2 }],
    },
    result: { valid: [{ post: channelUserPost }], invalid: [{}] },
  },
  'channel.updateTask': {
    params: {
      valid: [{ channelId: ids.channel, taskId: '1', status: 'completed' }],
      invalid: [{ channelId: ids.channel, taskId: '1', status: 'done' }],
    },
    result: { valid: [{ tasks: [boardTask] }, { tasks: [] }], invalid: [{}] },
  },
  'channel.wake': {
    params: { valid: [{ channelId: ids.channel }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
  },
  'channel.rotate': {
    params: { valid: [{ channelId: ids.channel }], invalid: [{}] },
    result: {
      valid: [
        {
          channel: {
            ...channelSample,
            coordinator: { ...(channelSample.coordinator as ChannelCoordinator), generation: 2 },
          },
        },
      ],
      invalid: [
        {
          channel: {
            ...channelSample,
            coordinator: { ...channelSample.coordinator, generation: 0 },
          },
        },
      ],
    },
  },
  'channel.stop': {
    params: { valid: [{ channelId: ids.channel }], invalid: [{}, { channelId: 'x' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'notification.subscribe': {
    params: { valid: [{}], invalid: [null, 'all'] },
    result: { valid: [{}], invalid: [null] },
  },
  'presence.update': {
    params: { valid: [{ active: true }, { active: false }], invalid: [{}, { active: 'yes' }] },
    result: { valid: [{}], invalid: [null] },
  },
  'device.list': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { devices: [] },
        { devices: [deviceSample, { ...deviceSample, status: 'revoked' }] },
        { devices: [deviceSample, webDeviceSample] },
      ],
      invalid: [{}, { devices: [{ ...deviceSample, publicKey: 'short' }] }],
    },
  },
  'device.update': {
    params: {
      valid: [
        { id: ids.device, name: 'Pixel' },
        { id: ids.device, permissions: ['session.read', 'terminal.write'] },
        { id: ids.device, push: { enabled: false } },
      ],
      invalid: [
        {},
        { id: ids.device, name: '' },
        { id: ids.device, name: 'x'.repeat(65) },
        { id: ids.device, push: {} },
      ],
    },
    result: {
      valid: [{ device: deviceSample }, { device: devicePushSample }],
      invalid: [{}, { device: { ...devicePushSample, push: { enabled: true } } }],
    },
  },
  'device.revoke': {
    params: { valid: [{ id: ids.device }], invalid: [{}, { id: 'device' }] },
    result: {
      valid: [{ device: { ...deviceSample, status: 'revoked' } }],
      invalid: [{ device: { ...deviceSample, status: 'paused' } }],
    },
  },
  'pairing.start': {
    params: { valid: [{}, { web: true }, { web: false }], invalid: [null, { web: 'yes' }] },
    result: {
      valid: [
        pairingOfferSample,
        {
          ...pairingOfferSample,
          candidates: [
            { kind: 'lan', host: '192.168.1.20', port: 47_900 },
            { kind: 'tailscale', host: 'fd7a:115c:a1e0::1', port: 47_900 },
          ],
          relayUrl: 'wss://relay.example.com',
        },
        webPairingOfferSample,
      ],
      invalid: [
        { ...pairingOfferSample, shortCode: '7KQ2M9XI' },
        { ...webPairingOfferSample, web: false },
        { ...pairingOfferSample, relayUrl: 'https://relay.example.com' },
      ],
    },
  },
  'pairing.cancel': {
    params: { valid: [{}, { pairingId: ids.pairing }], invalid: [{ pairingId: ids.device }] },
    result: { valid: [{}], invalid: [null] },
  },
  'pairing.respond': {
    params: {
      valid: [
        { requestId: ids.pairingRequest, allow: true },
        { requestId: ids.pairingRequest, allow: false },
        { requestId: ids.pairingRequest, allow: true, push: true },
      ],
      invalid: [
        { requestId: ids.pairingRequest },
        { requestId: ids.pairing, allow: true },
        { requestId: ids.pairingRequest, allow: true, push: 'yes' },
      ],
    },
    result: { valid: [{}, { device: deviceSample }, { device: webDeviceSample }], invalid: [null] },
  },
  'remote.status': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        remoteStatusSample,
        remoteOffSample,
        remoteRelaySample,
        remoteRelayRetrySample,
        remoteRelayRejectedSample,
        remoteRelayCertificateSample,
        remotePushSample,
      ],
      invalid: [
        { ...remoteStatusSample, port: 0 },
        { ...remotePushSample, push: { state: 'down', gatewayUrl: 'https://x', devices: 0 } },
        {
          ...remoteRelaySample,
          relay: { state: 'off', url: 'wss://relay.example.com', connections: 0 },
        },
        {
          ...remoteRelayRejectedSample,
          relay: {
            state: 'connecting',
            url: 'wss://relay.example.com',
            connections: 0,
            error: { reason: 'rejected', message: 'x', httpStatus: 700 },
          },
        },
        { ...remoteRelaySample, relay: { state: 'connected', url: 'https://x', connections: 0 } },
        { ...remoteStatusSample, interfaces: [{ name: 'en0', family: 'IPv4', kind: 'public' }] },
        { ...remoteStatusSample, error: { reason: 'busy', message: 'x' } },
      ],
    },
  },
  'push.get': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [pushStateSample, { ...pushStateSample, enabled: false, registered: false }],
      invalid: [{ ...pushStateSample, gatewayUrl: 'wss://push.wevir.si' }, { enabled: true }],
    },
  },
  'push.register': {
    params: {
      valid: [
        { platform: 'apns', token: 'a'.repeat(64), code: 'AAAAAAAAAAAAAAAAAAAAAA' },
        { platform: 'fcm', token: 'dQw4w9WgXcQ:APA91b-x_y', code: 'abc_DEF-0123456789abcd' },
      ],
      invalid: [
        { platform: 'apns', token: 'a'.repeat(64) },
        { platform: 'hms', token: 'a'.repeat(64), code: 'AAAAAAAAAAAAAAAAAAAAAA' },
        { platform: 'apns', token: 'a b c d e f', code: 'AAAAAAAAAAAAAAAAAAAAAA' },
      ],
    },
    result: { valid: [pushStateSample], invalid: [{}] },
  },
  'push.unregister': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [{ ...pushStateSample, registered: false }],
      invalid: [{ ...pushStateSample, routeId: 'x' }],
    },
  },
  'inbox.dismiss': {
    params: {
      valid: [{ itemId: `turn_failed:${ids.turn}` }, { itemId: `automation:${ids.automationRun}` }],
      invalid: [{}, { itemId: '' }, { itemId: 'turn failed' }],
    },
    result: { valid: [{}], invalid: [null] },
  },
  'approval.respond': {
    params: {
      valid: [
        { approvalId: ids.approval, optionId: 'allow-once' },
        // 0.80.0：总是允许，只对这个项目。
        { approvalId: ids.approval, optionId: 'allow-once', remember: 'project' },
      ],
      invalid: [
        { approvalId: ids.approval },
        { approvalId: ids.approval, optionId: 'allow-once', remember: 'session' },
      ],
    },
    result: {
      valid: [
        { approvalId: ids.approval, status: 'approved', resolution: userResolution },
        {
          approvalId: ids.approval,
          status: 'approved',
          resolution: { ...userResolution, ruleIds: [ids.approvalRule] },
        },
      ],
      invalid: [{ approvalId: ids.approval, status: 'pending', resolution: userResolution }],
    },
  },
  'approvalRule.list': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 'x' }] },
    result: {
      valid: [
        {
          rules: [
            approvalRule,
            { ...approvalRule, workspaceId: undefined, useCount: 0, lastUsedAt: undefined },
          ],
        },
      ],
      invalid: [{ rules: [{ ...approvalRule, prefix: [] }] }],
    },
  },
  'approvalRule.add': {
    params: {
      valid: [
        { prefix: ['pnpm', 'test'] },
        { prefix: ['git', 'diff'], workspaceId: ids.workspace },
      ],
      invalid: [{ prefix: [] }, { prefix: [''] }],
    },
    result: {
      valid: [{ rule: approvalRule }],
      invalid: [{ rule: { ...approvalRule, useCount: -1 } }],
    },
  },
  'approvalRule.delete': {
    params: { valid: [{ ruleId: ids.approvalRule }], invalid: [{ ruleId: ids.approval }] },
    result: { valid: [{ deleted: true }, { deleted: false }], invalid: [{}] },
  },
  'approvalRule.suggest': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 1 }] },
    result: {
      valid: [
        {
          suggestions: [
            {
              prefix: ['pnpm', 'test'],
              workspaceId: ids.workspace,
              count: 3,
              lastApprovedAt: TS2,
              example: 'pnpm test --filter host',
            },
          ],
        },
        { suggestions: [] },
      ],
      invalid: [{ suggestions: [{ prefix: ['pnpm'], workspaceId: ids.workspace, count: 0 }] }],
    },
  },
  'tuning.get': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 'x' }] },
    result: {
      valid: [
        {
          profile,
          latest: profileVersionSummary,
          pending: true,
          pendingLayers: ['rules', 'memory'],
        },
        { profile: { fingerprint: HASH_A, layers: [] }, pending: false, pendingLayers: [] },
      ],
      invalid: [{ profile: { ...profile, fingerprint: 'abc' }, pending: false, pendingLayers: [] }],
    },
  },
  'tuning.versions': {
    params: {
      valid: [{}, { workspaceId: ids.workspace, cursor: '7', limit: 20 }],
      invalid: [{ limit: 0 }],
    },
    result: {
      valid: [
        {
          versions: [
            profileVersionSummary,
            { ...profileVersionSummary, id: ids.profileVersion2, seq: 1, changes: undefined },
          ],
          nextCursor: '1',
        },
        { versions: [] },
        // 0.87.0：采纳建议之后开的版本。
        { versions: [{ ...profileVersionSummary, cause: { proposalIds: [ids.tuningProposal] } }] },
      ],
      invalid: [
        { versions: [{ ...profileVersionSummary, seq: 0 }] },
        { versions: [{ ...profileVersionSummary, cause: { proposalIds: [] } }] },
      ],
    },
  },
  'tuning.version': {
    params: {
      valid: [{ versionId: ids.profileVersion }],
      invalid: [{ versionId: ids.approvalRule }],
    },
    result: {
      valid: [
        {
          version: { ...profileVersionSummary, layers: profile.layers, wevirVersion: '0.1.0' },
          sessionIds: [ids.session],
        },
      ],
      invalid: [{ version: profileVersionSummary, sessionIds: [] }],
    },
  },
  'tuning.diff': {
    params: {
      valid: [
        { from: ids.profileVersion2, to: ids.profileVersion },
        { from: ids.profileVersion, to: 'current' },
      ],
      invalid: [{ from: ids.profileVersion, to: 'latest' }],
    },
    result: {
      valid: [
        {
          from: { ...profileVersionRef, id: ids.profileVersion2, seq: 6, fingerprint: HASH_A },
          to: profileVersionRef,
          layers: [
            {
              key: 'rules',
              items: [
                {
                  id: profileItem.id,
                  label: profileItem.label,
                  scope: 'project',
                  change: 'modified',
                  before: { ...profileItem, hash: HASH_B },
                  after: profileItem,
                },
              ],
            },
            {
              key: 'memory',
              items: [
                {
                  id: 'project/test-before-build',
                  label: 'test-before-build',
                  scope: 'project',
                  change: 'added',
                  after: {
                    id: 'project/test-before-build',
                    label: 'test-before-build',
                    scope: 'project',
                    hash: HASH_C,
                    text: true,
                  },
                },
              ],
            },
          ],
        },
        { from: profileVersionRef, to: { fingerprint: HASH_C }, layers: [] },
      ],
      invalid: [
        {
          from: profileVersionRef,
          to: profileVersionRef,
          layers: [{ key: 'rules', items: [{ ...profileItem, change: 'renamed' }] }],
        },
      ],
    },
  },
  'tuning.blob': {
    params: { valid: [{ hash: HASH_A }], invalid: [{ hash: 'ABC' }] },
    result: { valid: [{ text: '# AGENTS.md\n' }, {}], invalid: [{ text: 1 }] },
  },
  'guardrail.list': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 'x' }] },
    result: {
      valid: [{ guardrails: [globalGuardrail, guardrail] }, { guardrails: [] }],
      invalid: [{ guardrails: [{ ...guardrail, hits: -1 }] }],
    },
  },
  'guardrail.add': {
    params: {
      valid: [
        { rule: { kind: 'forbidden_command', match: 'regex', pattern: '\\bgit\\s+push\\b' } },
        {
          workspaceId: ids.workspace,
          name: '保护密钥',
          rule: { kind: 'protected_path', glob: '.env*' },
          enabled: false,
        },
        { rule: { kind: 'commit_check', command: 'pnpm lint', timeoutSec: 120 } },
      ],
      invalid: [
        { rule: { kind: 'protected_path', glob: '' } },
        { rule: { kind: 'stop_check', command: 'pnpm test', maxAttempts: 0 } },
        { rule: { kind: 'shell_hook', command: 'x' } },
      ],
    },
    result: { valid: [{ guardrail }], invalid: [{}] },
  },
  'guardrail.update': {
    params: {
      valid: [
        { guardrailId: ids.guardrail, name: null },
        {
          guardrailId: ids.guardrail,
          rule: { kind: 'stop_check', command: 'pnpm test --run', maxAttempts: 5 },
        },
      ],
      invalid: [{ guardrailId: ids.approvalRule }],
    },
    result: { valid: [{ guardrail }], invalid: [{ guardrail: { ...guardrail, revision: 0 } }] },
  },
  'guardrail.delete': {
    params: { valid: [{ guardrailId: ids.guardrail }], invalid: [{}] },
    result: { valid: [{}], invalid: ['x'] },
  },
  'guardrail.setEnabled': {
    params: {
      valid: [{ guardrailId: ids.guardrail, enabled: false }],
      invalid: [{ guardrailId: ids.guardrail }],
    },
    result: { valid: [{ guardrail: globalGuardrail }], invalid: [{ guardrail: null }] },
  },
  'repoHook.list': {
    params: { valid: [{ workspaceId: ids.workspace }], invalid: [{}] },
    result: {
      valid: [
        {
          hooks: [
            repoHook,
            {
              id: '.codex/config.toml:stop:0:0',
              file: '.codex/config.toml',
              event: 'Stop',
              handler: 'mcp_tool',
              hash: 'sha256:986c1d80d388aded1290775be2649e6ff370e859042cbd29bdd8471950dec011',
              status: 'unsupported',
            },
          ],
          warnings: ['.codex/hooks.json: Unexpected token'],
        },
        { hooks: [], warnings: [] },
      ],
      invalid: [{ hooks: [{ ...repoHook, hash: '' }], warnings: [] }],
    },
  },
  'repoHook.setEnabled': {
    params: {
      valid: [{ workspaceId: ids.workspace, hookId: repoHook.id, enabled: true }],
      invalid: [{ workspaceId: ids.workspace, hookId: '', enabled: true }],
    },
    result: {
      valid: [
        { hook: repoHook },
        { hook: { ...repoHook, status: 'disabled', enabledAt: undefined } },
      ],
      invalid: [{ hook: { ...repoHook, file: '' } }],
    },
  },
  'hook.list': {
    params: { valid: [{ workspaceId: ids.workspace }, {}], invalid: [{ workspaceId: 'x' }] },
    result: {
      valid: [
        {
          hooks: [wevirHook, projectHook],
          warnings: ['.wevir/hooks.json: Unexpected token'],
          support: [
            { engine: 'codex', events: ['SessionStart', 'PreToolUse', 'Stop'] },
            { engine: 'copilot', events: ['SessionStart', 'Stop'] },
          ],
        },
        { hooks: [], warnings: [], support: [] },
      ],
      invalid: [{ hooks: [{ ...wevirHook, engines: undefined }], warnings: [], support: [] }],
    },
  },
  'hook.add': {
    params: {
      valid: [
        {
          workspaceId: ids.workspace,
          name: '格式化',
          event: 'PostToolUse',
          matcher: 'Edit',
          handler: { type: 'command', command: 'pnpm exec biome format --write .', timeout: 60 },
        },
        { event: 'Stop', handler: { type: 'command', command: 'pnpm test', onFailure: 'block' } },
      ],
      invalid: [
        { event: 'Notification', handler: { type: 'command', command: 'x' } },
        { event: 'Stop', handler: { type: 'http', url: 'https://example.com' } },
      ],
    },
    result: { valid: [{ hook: wevirHook }], invalid: [{}] },
  },
  'hook.update': {
    params: {
      valid: [
        { hookId: wevirHook.id, matcher: null, name: null },
        { hookId: wevirHook.id, handler: { type: 'command', command: 'make fmt' } },
      ],
      invalid: [{ hookId: '' }],
    },
    result: { valid: [{ hook: { ...wevirHook, matcher: undefined } }], invalid: [{}] },
  },
  'hook.delete': {
    params: { valid: [{ hookId: wevirHook.id }], invalid: [{}] },
    result: { valid: [{}], invalid: ['x'] },
  },
  'hook.setEnabled': {
    params: {
      valid: [
        { workspaceId: ids.workspace, hookId: projectHook.id, enabled: true },
        { hookId: wevirHook.id, enabled: false },
      ],
      invalid: [{ hookId: wevirHook.id }],
    },
    result: {
      valid: [{ hook: { ...projectHook, status: 'enabled' } }],
      invalid: [{ hook: { ...projectHook, source: '' } }],
    },
  },
  'tuning.proposal.generate': {
    params: {
      valid: [{ sessionId: ids.session }, { sessionId: ids.session, replaces: ids.tuningProposal }],
      invalid: [{}, { sessionId: ids.session, replaces: ids.guardrail }],
    },
    result: {
      valid: [
        {
          proposals: [ruleProposal],
          usage: { inputTokens: 2400, outputTokens: 520 },
          summarized: true,
        },
        { proposals: [], usage: { inputTokens: 1800, outputTokens: 12 } },
        { proposals: [], reason: 'no_project' },
        // 0.108.0：生成的改动直接进入试用。
        {
          proposals: [{ ...trialProposal, origin: 'user' }],
          usage: { inputTokens: 900, outputTokens: 80 },
        },
      ],
      invalid: [{ proposals: [ruleProposal, ruleProposal, ruleProposal, ruleProposal] }],
    },
  },
  'tuning.proposal.list': {
    params: {
      valid: [{}, { workspaceId: ids.workspace, status: 'open' }, { status: 'decided' }],
      invalid: [{ status: 'accepted' }],
    },
    result: {
      valid: [
        { proposals: [ruleProposal, memoryProposal, guardrailProposal] },
        { proposals: [] },
        // 0.108.0：试用中与回退了的。
        { proposals: [trialProposal, revertedProposal] },
      ],
      invalid: [
        { proposals: [{ ...ruleProposal, status: 'superseded' }] },
        { proposals: [{ ...trialProposal, origin: 'cron' }] },
        { proposals: [{ ...ruleProposal, change: { kind: 'rule', path: '/x' } }] },
        { proposals: [{ ...ruleProposal, evidence: Array(9).fill({ id: 'e1', text: '' }) }] },
      ],
    },
  },
  'tuning.proposal.update': {
    params: {
      valid: [
        { proposalId: ids.tuningProposal, after: '# AGENTS.md\n' },
        { proposalId: ids.tuningProposal2, after: 'x', description: '金额以分存储' },
        {
          proposalId: ids.tuningProposal,
          rule: { kind: 'protected_path', glob: '.env*' },
          name: null,
        },
      ],
      invalid: [{ after: 'x' }, { proposalId: ids.tuningProposal, description: ' ' }],
    },
    result: { valid: [{ proposal: ruleProposal }], invalid: [{}] },
  },
  'tuning.proposal.decide': {
    params: {
      valid: [
        { proposalId: ids.tuningProposal, decision: 'accept' },
        { proposalId: ids.tuningProposal, decision: 'reject' },
      ],
      invalid: [{ proposalId: ids.tuningProposal, decision: 'later' }],
    },
    result: {
      valid: [
        { proposal: memoryProposal },
        { proposal: guardrailProposal },
        // 0.108.0：试用中的提前保留。
        {
          proposal: {
            ...trialProposal,
            status: 'accepted',
            outcome: { decidedBy: 'user', result: 'kept', reason: 'manual', decidedAt: TS2 },
          },
        },
      ],
      invalid: [{ proposal: { ...memoryProposal, stats: { sessions: -1 } } }],
    },
  },
  'tuning.proposal.revert': {
    params: { valid: [{ proposalId: ids.tuningProposal }], invalid: [{}, { proposalId: 'x' }] },
    result: {
      valid: [{ proposal: revertedProposal }],
      invalid: [
        {
          proposal: {
            ...revertedProposal,
            outcome: { ...revertedProposal.outcome, result: 'undone' },
          },
        },
      ],
    },
  },
  'tuning.overview': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 'x' }] },
    result: {
      valid: [
        {
          auto: { enabled: true, decided: true },
          budget: {
            month: '2026-10',
            limitTokens: 200_000,
            usedTokens: 38_000,
            autoTokens: 31_000,
            exhausted: false,
          },
          trial: {
            proposalIds: [ids.tuningProposal],
            startVersion: profileVersionRef,
            sessions: 3,
            needed: 5,
            startedAt: TS,
            deadline: '2026-10-26T08:00:00.000Z',
          },
          series: [
            {
              version: { ...profileVersionRef, seq: 6 },
              createdAt: TS,
              metrics: tuningMetrics,
            },
            {
              version: profileVersionRef,
              createdAt: TS2,
              metrics: { sessions: 3, turns: 9, failedTurns: 0, guardrailHits: 0 },
              trial: true,
            },
          ],
          totals: { adopted: 7, kept: 5, reverted: 2 },
          lastRun: {
            at: TS2,
            origin: 'auto',
            proposals: 1,
            usage: { inputTokens: 6200, outputTokens: 640 },
          },
        },
        // 全局范围、还没在引导里选过。
        {
          auto: { enabled: false, decided: false },
          budget: {
            month: '2026-10',
            limitTokens: 200_000,
            usedTokens: 0,
            autoTokens: 0,
            exhausted: false,
          },
          series: [],
        },
      ],
      invalid: [
        {
          auto: { enabled: true, decided: true },
          budget: {
            month: '2026/10',
            limitTokens: 0,
            usedTokens: 0,
            autoTokens: 0,
            exhausted: false,
          },
          series: [],
        },
        {
          auto: { enabled: true, decided: true },
          budget: {
            month: '2026-10',
            limitTokens: 0,
            usedTokens: 0,
            autoTokens: 0,
            exhausted: false,
          },
          trial: { proposalIds: [], sessions: 0, needed: 5, startedAt: TS, deadline: TS2 },
          series: [],
        },
      ],
    },
  },
  'office.status': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { status: officeEngineMissing },
        { status: officeEngineReady },
        {
          status: {
            ...officeEngineMissing,
            state: 'installing',
            progress: { completedBytes: 1024, totalBytes: 61_000_000 },
          },
        },
        { status: { ...officeEngineMissing, state: 'failed', error: 'checksum mismatch' } },
        {
          status: {
            state: 'unsupported',
            engineName: 'LibreOffice',
            version: '0.2.0',
            downloadBytes: 0,
          },
        },
      ],
      invalid: [{ status: { ...officeEngineMissing, state: 'downloading' } }, {}],
    },
  },
  'office.install': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: officeEngineMissing }], invalid: [{ status: {} }] },
  },
  'office.cancelInstall': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: officeEngineMissing }], invalid: [{}] },
  },
  'office.uninstall': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: officeEngineMissing }], invalid: [{}] },
  },
  'speech.status': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [
        { status: { local: speechLocalMissing } },
        { status: { local: speechLocalReady } },
        {
          status: {
            local: {
              ...speechLocalMissing,
              state: 'installing',
              progress: { phase: 'downloading', completedBytes: 1024, totalBytes: 166_427_732 },
            },
          },
        },
        {
          status: { local: { ...speechLocalMissing, state: 'failed', error: 'sha256 mismatch' } },
        },
        { status: { local: { ...speechLocalMissing, state: 'unsupported' } } },
      ],
      invalid: [{ status: { local: { ...speechLocalMissing, state: 'downloading' } } }, {}],
    },
  },
  'speech.install': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: { local: speechLocalMissing } }], invalid: [{ status: {} }] },
  },
  'speech.cancelInstall': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: { local: speechLocalMissing } }], invalid: [{}] },
  },
  'speech.uninstall': {
    params: { valid: [{}], invalid: [null] },
    result: { valid: [{ status: { local: speechLocalMissing } }], invalid: [{}] },
  },
  'speech.begin': {
    params: { valid: [{}], invalid: [null] },
    result: {
      valid: [{ recordingId: 'rec_01JA2B3C4D5E6F7G' }],
      invalid: [{ recordingId: 'x' }, {}],
    },
  },
  'speech.append': {
    params: {
      valid: [
        { recordingId: 'rec_01JA2B3C4D5E6F7G', offset: 0, data: 'AAAAAA==' },
        { recordingId: 'rec_01JA2B3C4D5E6F7G', offset: 32_000, data: 'AQIDBA==' },
      ],
      invalid: [
        { recordingId: 'rec_01JA2B3C4D5E6F7G', offset: -1, data: 'AAAA' },
        { recordingId: 'rec_01JA2B3C4D5E6F7G', offset: 0, data: '' },
        { recordingId: 'rec_01JA2B3C4D5E6F7G', data: 'AAAA' },
      ],
    },
    result: { valid: [{ receivedBytes: 4 }], invalid: [{ receivedBytes: -1 }] },
  },
  'speech.finish': {
    params: {
      valid: [
        { recordingId: 'rec_01JA2B3C4D5E6F7G' },
        { recordingId: 'rec_01JA2B3C4D5E6F7G', sessionId: ids.session },
      ],
      invalid: [{}, { recordingId: 'rec_01JA2B3C4D5E6F7G', sessionId: 'x' }],
    },
    result: {
      valid: [
        { text: '把测试跑一遍', transcriber: { kind: 'local' }, durationMs: 1800 },
        {
          text: '把测试跑一遍。',
          transcriber: { kind: 'provider', providerId: 'groq', modelId: 'whisper-large-v3' },
          polished: true,
          durationMs: 1800,
        },
        { text: '', transcriber: { kind: 'local' }, durationMs: 300 },
      ],
      invalid: [
        { text: 'x', durationMs: 1 },
        { text: 'x', transcriber: { kind: 'local' }, durationMs: -1 },
      ],
    },
  },
  'speech.discard': {
    params: { valid: [{ recordingId: 'rec_01JA2B3C4D5E6F7G' }], invalid: [{}] },
    result: { valid: [{}], invalid: [null] },
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
        // 0.113.0：增量快照。
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
              '# in: - form "Login"\n-   - textbox "Email" [ref=@e3]\n+   - textbox "Email" [value="a@b.c" ref=@e3]',
            truncated: false,
            stats: {
              nodeCount: 40,
              refCount: 6,
              textLength: 90,
              totalLines: 30,
              startLine: 0,
              shownLines: 30,
              changes: { added: 1, removed: 1, unchanged: 29 },
            },
          },
        },
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
        // 0.89.0
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'list_tabs',
            tabs: [{ ...browserTab, controller: 'user', origin: 'agent', disposition: 'handoff' }],
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'finalize_tabs',
            tabs: [
              {
                browserId: browserTab.browserId,
                url: browserTab.url,
                title: browserTab.title,
                outcome: 'deliverable',
              },
              {
                browserId: 'tab_m2k1_2',
                url: 'https://example.com/',
                title: '',
                outcome: 'closed',
              },
            ],
          },
        },
        {
          requestId: ids.browserRequest,
          ok: true,
          result: {
            command: 'claim_tab',
            browserId: browserTab.browserId,
            url: browserTab.url,
            title: browserTab.title,
            previousController: 'user',
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
  'computer.register': {
    params: {
      valid: [{ commands: ['request_access', 'screenshot', 'click'] }, { commands: ['someday'] }],
      invalid: [{ commands: [] }, { commands: [''] }],
    },
    result: empty,
  },
  'computer.unregister': { params: empty, result: empty },
  'computer.respond': {
    params: {
      valid: [
        {
          requestId: ids.computerRequest,
          ok: true,
          result: { content: [{ type: 'text', text: 'Clicked at (412, 88) in Notes.' }] },
        },
        {
          requestId: ids.computerRequest,
          ok: true,
          result: {
            content: [
              { type: 'text', text: 'Screenshot of Notes, 1400x900.' },
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            ],
          },
        },
        {
          requestId: ids.computerRequest,
          ok: false,
          error: {
            code: 'computer_tier_denied',
            message: 'Terminal is approved for left clicks only.',
          },
        },
        {
          requestId: ids.computerRequest,
          ok: false,
          error: { code: 'computer_stopped', message: 'The user pressed Esc.' },
          content: [{ type: 'text', text: '1. click: done' }],
        },
      ],
      invalid: [
        { requestId: ids.computerRequest, ok: true, result: { content: [] } },
        { requestId: ids.computerRequest, ok: false, error: { code: '', message: 'x' } },
        {
          requestId: ids.computerRequest,
          ok: true,
          result: { content: [{ type: 'image', data: 'x', mimeType: 'image/gif' }] },
        },
      ],
    },
    result: { valid: [{ accepted: true }, { accepted: false }], invalid: [{}] },
  },
  'events.subscribe': {
    params: {
      valid: [
        { sessionId: ids.session, sinceSeq: 0 },
        { sessionId: ids.session, sinceSeq: 12 },
        { sessionId: ids.session, sinceSeq: 0, elideSuperseded: true },
      ],
      invalid: [
        { sessionId: ids.session },
        { sessionId: ids.session, sinceSeq: 1.5 },
        { sessionId: ids.session, sinceSeq: 0, elideSuperseded: 'yes' },
      ],
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
  'devices.changed': {
    valid: [{ devices: [] }, { devices: [deviceSample] }, { devices: [webDeviceSample] }],
    invalid: [{}, { devices: [{ ...deviceSample, platform: 'watch' }] }],
  },
  'pairing.request': {
    valid: [
      {
        pairingId: ids.pairing,
        requestId: ids.pairingRequest,
        name: 'iPhone',
        platform: 'ios',
        requestedAt: TS,
      },
      {
        pairingId: ids.pairing,
        requestId: ids.pairingRequest,
        name: 'Chrome',
        platform: 'web',
        requestedAt: TS,
      },
    ],
    invalid: [{ pairingId: ids.pairing, requestId: ids.pairingRequest, name: '', platform: 'ios' }],
  },
  'pairing.ended': {
    valid: [
      { pairingId: ids.pairing, reason: 'paired', deviceId: ids.device },
      { pairingId: ids.pairing, reason: 'expired' },
      { pairingId: ids.pairing, reason: 'failed' },
    ],
    invalid: [{ pairingId: ids.pairing, reason: 'timeout' }, { pairingId: ids.pairing }],
  },
  'remote.changed': {
    valid: [
      remoteStatusSample,
      remoteOffSample,
      remoteRelaySample,
      remoteRelayRetrySample,
      remoteRelayRejectedSample,
      remoteRelayCertificateSample,
      remotePushSample,
    ],
    invalid: [{ ...remoteStatusSample, connections: -1 }, { listening: true }],
  },
  'push.changed': {
    valid: [pushStateSample, { ...pushStateSample, enabled: false, registered: false }],
    invalid: [{ ...pushStateSample, enabled: 'yes' }],
  },
  'channels.changed': {
    valid: [
      { listVersion: 8, upserted: [channelSample], removed: [] },
      { listVersion: 9, upserted: [], removed: [ids.channel] },
    ],
    invalid: [
      { listVersion: 8, upserted: [] },
      { listVersion: 8, upserted: [], removed: [ids.session] },
    ],
  },
  'channel.posted': {
    valid: channelPostSamples.valid.map((post) => ({ subscriptionId: ids.subscription, post })),
    invalid: channelPostSamples.invalid.map((post) => ({ subscriptionId: ids.subscription, post })),
  },
  'channel.updated': {
    valid: [
      { subscriptionId: ids.subscription, channel: channelSample },
      {
        subscriptionId: ids.subscription,
        posts: [{ ...channelUserPost, routedTo: [ids.session] }],
        threads: [channelThread],
        approvals: [],
        tasks: [boardTask],
      },
    ],
    invalid: [{ channel: channelSample }, { subscriptionId: ids.subscription, threads: [{}] }],
  },
  'inbox.changed': {
    valid: [
      { inboxVersion: 12, upserted: [inboxApproval, inboxTurnFailed], removed: [] },
      { inboxVersion: 13, upserted: [], removed: [`question:${ids.question}`] },
      { inboxVersion: 14, upserted: [], removed: [] },
    ],
    invalid: [
      { inboxVersion: 12, upserted: [] },
      { inboxVersion: 12, upserted: [{ ...inboxApproval, kind: 'note' }], removed: [] },
      { inboxVersion: 12, upserted: [], removed: ['approval'] },
    ],
  },
  'notification.intent': {
    valid: [
      approvalIntent,
      automationIntent,
      { ...approvalIntent, id: `completed:${ids.turn}`, kind: 'completed', body: '', title: '' },
      {
        id: `channel:${ids.channelPost}`,
        kind: 'channel',
        channelId: ids.channel,
        workspaceId: ids.workspace,
        title: 'Mail desk',
        body: 'Two new emails from the school.',
        createdAt: TS2,
        collapseKey: `channel:${ids.channel}`,
      },
      {
        id: `agent:${ids.session}:1792656000000`,
        kind: 'agent',
        sessionId: ids.session,
        workspaceId: ids.workspace,
        title: 'Deploy',
        body: 'Staging is down; approve the rollback.',
        createdAt: TS2,
        collapseKey: `agent:${ids.session}`,
      },
    ],
    invalid: [
      {},
      { ...approvalIntent, kind: 'note' },
      { ...approvalIntent, id: 'approval' },
      { ...approvalIntent, body: 'x'.repeat(301) },
      { ...automationIntent, automationStatus: 'running' },
    ],
  },
  'sessions.changed': {
    valid: [
      { listVersion: 7, upserted: [{ ...session, pendingApprovalCount: 1 }], removed: [] },
      { listVersion: 8, upserted: [], removed: [ids.childSession] },
      { listVersion: 9, upserted: [], removed: [] },
    ],
    invalid: [
      { listVersion: 7, upserted: [] },
      { listVersion: -1, upserted: [], removed: [] },
      { listVersion: 7, upserted: [], removed: [ids.workspace] },
    ],
  },
  'account.updated': {
    valid: [
      { account: signedInAccount },
      { account: signingInAccount },
      { account: claudeAccount },
      { account: antigravityInstalling },
      { account: workbuddyAccount },
      { account: devinAccount },
      { account: devinSigningIn },
      { account: copilotAccount },
      { account: copilotSigningIn },
      { account: kiroAccount },
      { account: kiroSigningIn },
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
  'preview.changed': {
    valid: [{ workspaceId: ids.workspace, configs: [previewConfig] }],
    invalid: [{ workspaceId: ids.workspace }],
  },
  'speech.changed': {
    valid: [{ status: { local: speechLocalReady } }],
    invalid: [{}, { status: { local: { state: 'ready' } } }],
  },
  'office.changed': {
    valid: [{ status: officeEngineReady }],
    invalid: [{}, { status: { state: 'ready' } }],
  },
  'market.installProgress': {
    valid: [
      { entry: 'notes', phase: 'download', receivedBytes: 512, totalBytes: 2048 },
      { entry: 'notes', phase: 'install', receivedBytes: 2048, totalBytes: 2048 },
    ],
    invalid: [
      { entry: 'notes', phase: 'verify', receivedBytes: 0, totalBytes: 1 },
      { entry: 'notes', phase: 'download', receivedBytes: -1, totalBytes: 1 },
    ],
  },
  'power.changed': {
    valid: [{ keepAwake: true }, { keepAwake: false }],
    invalid: [{}, { keepAwake: 1 }],
  },
  'tuning.changed': {
    valid: [{}, { workspaceId: ids.workspace }],
    invalid: [{ workspaceId: 'x' }],
  },
  'guardrail.changed': {
    valid: [{}, { workspaceId: ids.workspace }],
    invalid: [{ workspaceId: 'global' }],
  },
  'tuning.proposal.changed': {
    valid: [{}, { workspaceId: ids.workspace }],
    invalid: [{ workspaceId: 'x' }],
  },
  'readiness.changed': {
    valid: [
      { workspaceId: ids.workspace, root: '/home/u/projects/demo', run: installRun },
      { workspaceId: ids.workspace, root: '/home/u/projects/demo', report: readinessReport },
    ],
    invalid: [{ workspaceId: ids.workspace }],
  },
  'terminal.output': {
    valid: [{ terminalId: terminalSample.id, offset: 0, data: '\u001b[1mhi\u001b[0m' }],
    invalid: [{ terminalId: terminalSample.id, data: 'x' }],
  },
  'lsp.changed': {
    valid: [{}, { serverId: 'typescript', root: '/home/u/projects/demo' }],
    invalid: [{ serverId: '' }],
  },
  'simulator.changed': {
    valid: [{ devices: [] }, { devices: [simulatorDeviceSample, simulatorShutdownSample] }],
    invalid: [{}],
  },
  'simulator.show': {
    valid: [{ udid: simulatorDeviceSample.udid, sessionId: ids.session }],
    invalid: [{ udid: simulatorDeviceSample.udid }],
  },
  'simulator.orientation': {
    valid: [
      { udid: simulatorDeviceSample.udid, orientation: 'landscapeLeft' },
      {
        udid: simulatorDeviceSample.udid,
        orientation: 'landscapeLeft',
        screen: { width: 874, height: 402, scale: 3 },
      },
    ],
    invalid: [{ udid: simulatorDeviceSample.udid, orientation: 'up' }],
  },
  'terminal.changed': {
    valid: [{ terminal: terminalSample }, { removed: { id: terminalSample.id } }],
    invalid: [{}, { removed: {} }],
  },
  'automation.changed': {
    valid: [
      { automationId: ids.automation },
      { automationId: ids.automation, run: automationRunSample },
      { automationId: ids.automation, run: automationRunSilentSample },
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
      // 0.113.0
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'snapshot', args: { browserId: browserTab.browserId, changes: true } },
      },
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
      // 0.89.0
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'finalize_tabs',
          args: { keep: [{ browserId: browserTab.browserId, status: 'deliverable' }] },
        },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'finalize_tabs', args: { keep: [] } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: { command: 'claim_tab', args: { browserId: browserTab.browserId } },
      },
    ],
    invalid: [
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        cwd: '/Users/me/projects/wevir',
        command: {
          command: 'finalize_tabs',
          args: { keep: [{ browserId: browserTab.browserId, status: 'later' }] },
        },
      },
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
  'computer.request': {
    valid: [
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: {
          command: 'request_access',
          args: { apps: ['com.apple.Notes', '备忘录'], reason: 'Write the meeting notes.' },
        },
      },
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: { command: 'screenshot', args: { app: 'com.apple.Notes' } },
      },
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: { command: 'click', args: { x: 412, y: 88, modifiers: ['cmd'] } },
      },
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: {
          command: 'batch',
          args: {
            actions: [
              { command: 'click', args: { ref: '@a3' } },
              { command: 'type', args: { text: 'Hello' } },
              { command: 'wait', args: { seconds: 0.5 } },
              { command: 'key', args: { keys: 'cmd+s' } },
            ],
          },
        },
      },
    ],
    invalid: [
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: { command: 'request_access', args: { apps: [], reason: 'x' } },
      },
      {
        requestId: ids.computerRequest,
        sessionId: ids.session,
        command: { command: 'click', args: { ref: '@e1' } },
      },
      {
        requestId: ids.browserRequest,
        sessionId: ids.session,
        command: { command: 'list_apps', args: {} },
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
  DEVICE_FORBIDDEN: {
    valid: { missing: ['policy.write'] },
    invalid: { missing: [] },
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
      // 0.131.0：结算的时刻。
      resolvedAt: TS2,
    },
    invalid: { approvalId: ids.approval, status: 'cancelled', resolution: { reason: 'later' } },
  },
  APPROVAL_EXPIRED: {
    valid: {
      approvalId: ids.approval,
      resolution: { reason: 'timeout', optionId: 'reject-once' },
      resolvedAt: TS2,
    },
    invalid: { approvalId: ids.approval },
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
  SPEECH_FAILED: {
    valid: { reason: 'provider_error', failure: 'auth', httpStatus: 401 },
    invalid: { reason: 'offline' },
  },
  MCP_OAUTH_FAILED: {
    valid: { reason: 'client_id_required' },
    invalid: { reason: '' },
  },
  PUSH_GATEWAY_ERROR: {
    valid: { reason: 'bad_code' },
    invalid: { reason: 'not_bound' },
  },
  SIMULATOR_FAILED: {
    valid: { code: 'sim_not_booted' },
    invalid: { code: '' },
  },
};
