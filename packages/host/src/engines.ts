// 订阅来源的引擎（0.19.0，ADR-0005 补记 14）：Codex Host 除了 Codex 之外还挂哪些引擎。每个引擎一个适配器包
// （`@wevir/adapter-claude` 等，各自只声明自己引擎的 npm 包，AGENTS.md 规则 2），在这里登记成一条路由：名字、适配器、交给它的
// Provider 种类（`SUBSCRIPTION_KINDS` 里的一个）。适配器要实现 `accounts`（读状态、登录或给登录命令、模型列表），Host 据此
// 建这类 Provider；会话按 Provider 的种类交给它（engine-router.ts）。
//
// 引擎应当懒启动：构造适配器时不起进程、不联网，第一次读账号或建会话时才去找可执行文件。Host 启动时会在后台读一遍每种
// 订阅的账号状态（host-process.ts）。

import { join } from 'node:path';
import { AntigravityAdapter } from '@wevir/adapter-antigravity';
import { ClaudeAdapter, claudeSdkInstalled } from '@wevir/adapter-claude';
import { CopilotAdapter } from '@wevir/adapter-copilot';
import {
  CursorAdapter,
  CursorSdkInstaller,
  cursorSdkDirectory,
  cursorSdkInstalled,
  cursorSdkInstallSupported,
  isCursorShellSpawnFailure,
} from '@wevir/adapter-cursor';
import { DevinAdapter } from '@wevir/adapter-devin';
import { GrokAdapter } from '@wevir/adapter-grok';
import { OpenCodeAdapter } from '@wevir/adapter-opencode';
import { WorkBuddyAdapter } from '@wevir/adapter-workbuddy';
import type { AccountKind } from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import type { AdapterContext } from './cli.js';
import type { AccountEngineFactory, EngineRoute } from './engine-router.js';

/** 要连同 SDK 一起装的引擎：这个 Host 里有没有它们的 SDK。 */
export interface EngineSdks {
  claude: boolean;
  /**
   * `package`：Host 自己解析得到 `@cursor/sdk`（开发环境经 pnpm 装上）；安装器：安装包里不带，用户选用时下载到数据目录
   * （首个账号与添加的账号共用这一个）；`false`：SDK 没有本平台的构建，不挂 Cursor。
   */
  cursor: 'package' | CursorSdkInstaller | false;
}

/** 这个 Host 的 SDK：`subscriptionEngines` 与 `subscriptionAccountEngines` 要用同一份（cli.ts）。 */
export function engineSdks(context: Pick<AdapterContext, 'home'>): EngineSdks {
  return {
    claude: claudeSdkInstalled(),
    cursor: cursorSdkInstalled()
      ? 'package'
      : cursorSdkInstallSupported()
        ? new CursorSdkInstaller({ directory: cursorSdkDirectory(context.home) })
        : false,
  };
}

/** Cursor 适配器要的 SDK 选项。 */
function cursorSdkOption(sdks: EngineSdks): { sdkInstaller?: CursorSdkInstaller } {
  return sdks.cursor instanceof CursorSdkInstaller ? { sdkInstaller: sdks.cursor } : {};
}

/**
 * 现在挂上的订阅引擎。Claude Agent SDK 随安装包（ADR-0007 补记 6），没有时不挂 Claude。`@cursor/sdk` 不随安装包分发
 * （补记 3），用户在设置里选用 Cursor 时下载（adapter-cursor 的 sdk-install.ts），所以 Cursor 照样挂上、账号报没安装；只有本平台
 * 没有 SDK 的构建时不挂，桌面端的订阅来源里它显示为还不能用（没有这种账号）。开发环境里两个 SDK 都经 pnpm 装上。
 */
export function subscriptionEngines(
  context: AdapterContext,
  sdks: EngineSdks = engineSdks(context),
): EngineRoute[] {
  for (const [engine, installed] of Object.entries(sdks)) {
    if (installed === false) {
      context.logger.info('engine sdk not installed; engine disabled', { engine });
    } else if (installed instanceof CursorSdkInstaller) {
      context.logger.info('engine sdk installs on demand', { engine });
    }
  }
  const routes: EngineRoute[] = [
    {
      // Claude（claude-event-mapping.md）：用户自己装的 `claude` 与他的登录，经 Claude Agent SDK 驱动。
      name: 'claude',
      adapter: new ClaudeAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
      }),
      kinds: ['claude'],
    },
    // Cursor（@cursor/sdk 在 Host 进程里跑，docs/architecture/cursor-event-mapping.md）：SDK 第一次读账号或建会话时才加载。
    {
      name: 'cursor',
      adapter: new CursorAdapter({
        home: context.home,
        logger: context.logger,
        ...(context.env !== undefined && { env: context.env }),
        ...cursorSdkOption(sdks),
      }),
      kinds: ['cursor'],
    },
    // OpenCode（docs/architecture/opencode-event-mapping.md）：用户自己装的 `opencode` 与他接上的上游；本机的 `opencode serve`
    // 第一次读账号或建会话时才起，只听 127.0.0.1，Host 退出时停掉。
    {
      name: 'opencode',
      adapter: new OpenCodeAdapter({
        home: context.home,
        logger: context.logger,
        ...(context.env !== undefined && { env: context.env }),
      }),
      kinds: ['opencode'],
    },
    // Grok Build（grok-event-mapping.md）：用户自己装的 `grok` 与他的登录，经 ACP（`grok agent stdio`）驱动，每种权限模式一个
    // 进程，第一次读账号或建会话时才起。
    {
      name: 'grok',
      adapter: new GrokAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
      kinds: ['grok'],
    },
    // Antigravity（Google 的 ACP 运行体，antigravity-event-mapping.md）：Wevir 下载钉住的版本或用指定的可执行文件，私有
    // profile 在 <数据目录>/engines/antigravity；第一次建会话、登录或刷新时才启动。
    {
      name: 'antigravity',
      adapter: new AntigravityAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
      kinds: ['antigravity'],
    },
    // WorkBuddy：用户自己的 codebuddy --acp 与登录，复用通用 ACP 与 MCP 桥，按会话切权限。
    {
      name: 'workbuddy',
      adapter: new WorkBuddyAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
      kinds: ['workbuddy'],
    },
    // Devin（devin-event-mapping.md）：用户自己装的或 Wevir 下载的 `devin acp` 与 Devin 自己存的登录，复用通用 ACP 与 MCP 桥，
    // 按会话切模式；恢复用 session/load。
    {
      name: 'devin',
      adapter: new DevinAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
      kinds: ['devin'],
    },
    // GitHub Copilot（copilot-event-mapping.md）：用户自己装的或 Wevir 下载的 `copilot --acp` 与 Copilot 自己存的登录（系统钥匙串），
    // 复用通用 ACP 与 MCP 桥；完全访问由 Wevir 批准它的权限请求，恢复用 session/load。
    {
      name: 'copilot',
      adapter: new CopilotAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
      kinds: ['copilot'],
    },
  ];
  return routes.filter(
    (route) =>
      (route.name !== 'claude' || sdks.claude) &&
      (route.name !== 'cursor' || sdks.cursor !== false),
  );
}

/**
 * 添加的订阅账号（0.63.0）的引擎：同 `subscriptionEngines` 的那一种，凭据与会话放进账号自己的目录（`<数据目录>/accounts/<id>/`）。
 * 有 Claude、Cursor、Grok、Antigravity、OpenCode 与 GitHub Copilot（ChatGPT 的在 cli.ts）；OpenCode 只分开数据目录，用户的配置与上游
 * 照旧共用；Copilot 换掉 `COPILOT_HOME`（它在里面记用哪个 GitHub 账号，令牌在系统钥匙串里按账号存），并给一个空的 GitHub CLI 配置
 * 目录，不退回首个账号的 `gh` 登录。
 * WorkBuddy 没有能换的登录位置、也不能登出，Devin 的登录、会话与配置在同一组用户目录里，都只有首个账号。SDK 没有的种类不能添加；
 * Cursor 的 SDK 要下载时添加的账号与首个账号共用安装器，装好后一起能用。
 */
export function subscriptionAccountEngines(
  context: AdapterContext,
  sdks: EngineSdks = engineSdks(context),
): AccountEngineFactory {
  const env = context.env ?? process.env;
  const creators: Partial<Record<AccountKind, (root: string) => AgentRuntimeAdapter>> = {
    ...(sdks.claude && {
      claude: (root: string) =>
        new ClaudeAdapter({
          home: context.home,
          logger: context.logger,
          env,
          account: { configDir: join(root, 'claude'), workDir: join(root, 'work') },
          ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        }),
    }),
    ...(sdks.cursor !== false && {
      cursor: (root: string) =>
        new CursorAdapter({
          home: context.home,
          logger: context.logger,
          // 环境里的 CURSOR_API_KEY 是首个账号的事：添加的账号用它自己登录铸的 Key。
          env: withoutKeys(env, ['CURSOR_API_KEY']),
          credentialsPath: join(root, 'cursor', 'auth.json'),
          ...cursorSdkOption(sdks),
        }),
    }),
    grok: (root) =>
      new GrokAdapter({
        home: context.home,
        logger: context.logger,
        env,
        account: { grokHome: join(root, 'grok'), workDir: join(root, 'work') },
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
    opencode: (root) =>
      new OpenCodeAdapter({
        home: context.home,
        logger: context.logger,
        env,
        account: { dataHome: join(root, 'opencode') },
      }),
    antigravity: (root) =>
      new AntigravityAdapter({
        home: context.home,
        logger: context.logger,
        env,
        accountRoot: join(root, 'antigravity'),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
    copilot: (root) =>
      new CopilotAdapter({
        home: context.home,
        logger: context.logger,
        env,
        account: {
          copilotHome: join(root, 'copilot'),
          ghConfigDir: join(root, 'gh'),
          workDir: join(root, 'work'),
        },
        ...(context.historyTool !== undefined && { historyTool: context.historyTool }),
        ...(context.appToolsBridge !== undefined && { appToolsBridge: context.appToolsBridge }),
      }),
  };
  return {
    kinds: Object.keys(creators) as AccountKind[],
    create: (kind, { root }) => {
      const create = creators[kind];
      if (create === undefined) throw new Error(`${kind} accounts cannot be added`);
      return create(root);
    },
  };
}

function withoutKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * 在 Host 进程里跑的引擎留下的、只记日志不退出的 unhandled rejection（cli.ts）：Cursor SDK 给工具调用起 shell 失败时 reject 一个
 * 没人等的内部 promise（adapter-cursor 的 errors.ts）。
 */
export function isIgnorableEngineRejection(reason: unknown): boolean {
  return isCursorShellSpawnFailure(reason);
}
