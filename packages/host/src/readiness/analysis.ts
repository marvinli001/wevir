// 预检的中间结果（项目环境就绪，0.70.0）：各语言生态只读文件，给出文件层面的项、要探测的工具与安装方案的草稿；工具探测完之后由
// report.ts 拼成报告。

import type { InstallScripts, ReadinessEvidence, ReadinessItem } from '@wevir/protocol';

/** 一个要探测的工具与项目对它的要求。 */
export interface ToolNeed {
  /** probe.ts 的工具名（`node`、`pnpm`、`python3`、`go`、`cc`…）。 */
  tool: string;
  /** 报告里的名字（`python3` 显示成 `python`）。 */
  name?: string;
  kind: 'package_manager' | 'runtime' | 'compiler' | 'build_tool';
  /** 项目目录（相对根目录）。 */
  path: string;
  required?: string;
  /** 要求的写法：npm 的 semver 范围、PEP 440、最低版本、确切版本。 */
  rangeKind?: 'npm' | 'pep440' | 'min' | 'exact';
  /** 找不到时阻塞构建与测试。 */
  blocking: boolean;
  /** 版本不满足时也阻塞（例如 go.mod 要求更高的 Go）。 */
  versionBlocking: boolean;
  evidence: ReadinessEvidence[];
  /** 找不到它时可以代替的工具（Windows 上 `python3` 找不到时看 `python`）。 */
  fallback?: string;
}

/** 安装方案的草稿：`id` 与凭据在报告里补上。 */
export interface PlanDraft {
  path: string;
  manager: string;
  command: string;
  lockfile?: string;
  writesLockfile: boolean;
  reason: string;
  scripts: InstallScripts;
  /** 包管理器的版本已知后再定依赖脚本（pnpm 10 起默认只跑允许的）。 */
  dependencyScripts?: (managerVersion: string | undefined) => InstallScripts['dependencies'];
  /** 配置里引用的环境变量（凭据）。 */
  credentials: string[];
  /** 方案依据的文件状态（锁文件与清单的内容散列）：变了方案就变。 */
  fingerprint: string;
  /**
   * false：依赖与锁文件看着就绪，方案只在上次安装在这个目录没跑完（失败、停止、超时）时给出，因为包管理器可能已经写了一半的
   * 依赖目录。
   */
  needed: boolean;
}

export interface Analysis {
  projects: Array<{ path: string; ecosystems: string[] }>;
  items: ReadinessItem[];
  tools: ToolNeed[];
  plans: PlanDraft[];
}

export function emptyAnalysis(): Analysis {
  return { projects: [], items: [], tools: [], plans: [] };
}

export function mergeAnalysis(target: Analysis, part: Analysis): void {
  target.projects.push(...part.projects);
  target.items.push(...part.items);
  target.tools.push(...part.tools);
  target.plans.push(...part.plans);
}

/** 安装生命周期脚本：npm、pnpm、yarn 在安装时跑项目自己的这些脚本。 */
export const LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
] as const;
