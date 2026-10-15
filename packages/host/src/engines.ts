// 订阅来源的引擎（0.19.0，ADR-0005 补记 14）：Codex Host 除了 Codex 之外还挂哪些引擎。每个引擎一个适配器包
// （`@wevir/adapter-claude` 等，各自只声明自己引擎的 npm 包，AGENTS.md 规则 2），在这里登记成一条路由：名字、适配器、交给它的
// Provider 种类（`SUBSCRIPTION_KINDS` 里的一个）。适配器要实现 `accounts`（读状态、登录或给登录命令、模型列表），Host 据此
// 建这类 Provider；会话按 Provider 的种类交给它（engine-router.ts）。
//
// 引擎应当懒启动：构造适配器时不起进程、不联网，第一次读账号或建会话时才去找可执行文件。Host 启动时会在后台读一遍每种
// 订阅的账号状态（host-process.ts）。

import { AntigravityAdapter } from '@wevir/adapter-antigravity';
import { ClaudeAdapter } from '@wevir/adapter-claude';
import { CursorAdapter, isCursorShellSpawnFailure } from '@wevir/adapter-cursor';
import { GrokAdapter } from '@wevir/adapter-grok';
import { OpenCodeAdapter } from '@wevir/adapter-opencode';
import type { AdapterContext } from './cli.js';
import type { EngineRoute } from './engine-router.js';

/** 现在挂上的订阅引擎。 */
export function subscriptionEngines(context: AdapterContext): EngineRoute[] {
  return [
    {
      // Claude Agent（claude-event-mapping.md）：用户自己装的 `claude` 与他的登录，经 Claude Agent SDK 驱动。
      name: 'claude',
      adapter: new ClaudeAdapter({
        home: context.home,
        logger: context.logger,
        env: context.env ?? process.env,
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
      }),
      kinds: ['antigravity'],
    },
  ];
}

/**
 * 在 Host 进程里跑的引擎留下的、只记日志不退出的 unhandled rejection（cli.ts）：Cursor SDK 给工具调用起 shell 失败时 reject 一个
 * 没人等的内部 promise（adapter-cursor 的 errors.ts）。
 */
export function isIgnorableEngineRejection(reason: unknown): boolean {
  return isCursorShellSpawnFailure(reason);
}
