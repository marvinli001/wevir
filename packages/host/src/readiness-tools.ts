// 项目环境就绪的应用级工具（0.70.0）：`wevir_workspace_readiness` 只读，让 Agent 在动手之前知道会话目录的环境缺什么（工具、版本、依赖、
// 锁文件、检查命令）与网络情况。安装只由用户在 Wevir 里发起，这个工具不能装；归在工具预设的 `processes` 组。

import type { ReadinessItem, ReadinessReport, SessionId, WorkspaceId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { type AppTool, AppToolError } from './app-mcp.js';
import { objectSchema } from './app-tools.js';
import type { ReadinessService } from './readiness/service.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export interface ReadinessToolsOptions {
  readiness: Pick<ReadinessService, 'get'>;
  storage: Storage;
}

export function readinessTools({ readiness, storage }: ReadinessToolsOptions): AppTool[] {
  return [
    {
      name: 'wevir_workspace_readiness',
      title: 'Check the project environment',
      description:
        "Read-only check of this session's folder: which package managers, runtimes and compilers the project " +
        'needs and whether they are installed in a compatible version, whether the lockfile matches the manifests, ' +
        'whether dependencies are installed and up to date, whether the configured checks can run, and how the ' +
        'network looks for installs. Each finding lists its evidence (files read, `--version` output). It runs no ' +
        'project code and installs nothing. Use it before building or testing in an unfamiliar project, and when a ' +
        'command fails in a way that looks like a missing tool or dependency. Installing is up to the user: report ' +
        'what is missing instead of rewriting correct code around it. refresh re-runs the tool probes.',
      inputSchema: objectSchema({ refresh: { type: 'boolean' } }, []),
      annotations: READ,
      async call(args, call) {
        const record = storage.sessions.get(call.sessionId);
        const workspace = record && storage.workspaces.get(record.workspaceId);
        if (!record || !workspace || workspace.removedAt !== undefined) {
          throw new AppToolError('This Wevir session no longer exists.');
        }
        const report = await readiness.get({
          workspaceId: record.workspaceId as WorkspaceId,
          sessionId: call.sessionId as SessionId,
          ...(args.refresh === true && { refresh: true }),
        });
        return { content: [{ type: 'text', text: readinessText(report) }] };
      },
    },
  ];
}

const STATUS_TEXT: Record<ReadinessItem['status'], string> = {
  ready: 'ready',
  missing: 'not installed',
  incompatible: 'incompatible',
  network: 'network failure',
  permission: 'blocked by permissions',
  unknown: 'unknown',
};

function itemLine(item: ReadinessItem): string {
  const where = item.path === '' ? '.' : item.path;
  const parts = [`- [${STATUS_TEXT[item.status]}] ${item.kind} ${item.name} (${where})`];
  if (item.required !== undefined) parts.push(`requires ${item.required}`);
  if (item.found !== undefined) parts.push(`found ${item.found}`);
  if (item.reason !== undefined) parts.push(`reason ${item.reason}`);
  const evidence = item.evidence
    .map((entry) =>
      entry.kind === 'command'
        ? `ran \`${entry.command}\`${entry.exitCode !== undefined && entry.exitCode !== null ? ` → exit ${entry.exitCode}` : ''}${entry.output ? `: ${entry.output.split('\n')[0]?.slice(0, 160)}` : ''}`
        : entry.kind === 'env'
          ? `env ${entry.detail ?? ''}`
          : `read ${entry.path ?? ''}${entry.detail ? ` (${entry.detail})` : ''}`,
    )
    .slice(0, 4);
  return `${parts.join(', ')}${evidence.length > 0 ? `\n    evidence: ${evidence.join('; ')}` : ''}`;
}

/** 给模型看的报告。 */
export function readinessText(report: ReadinessReport): string {
  const lines: string[] = [];
  const status =
    report.status === 'ready'
      ? 'ready'
      : report.status === 'not_ready'
        ? 'NOT READY'
        : 'unknown (no recognised project)';
  lines.push(`Project environment of ${report.root}: ${status} (checked ${report.checkedAt}).`);
  if (report.projects.length > 0) {
    lines.push(
      `Projects: ${report.projects.map((project) => `${project.path === '' ? '.' : project.path} (${project.ecosystems.join(', ')})`).join('; ')}.`,
    );
  }
  const blocking = report.items.filter((item) => item.blocking && item.status !== 'ready');
  const other = report.items.filter((item) => !(item.blocking && item.status !== 'ready'));
  if (blocking.length > 0) {
    lines.push('', 'Blocking (builds and tests are expected to fail until these are fixed):');
    for (const item of blocking) lines.push(itemLine(item));
  }
  if (other.length > 0) {
    lines.push('', 'Other findings:');
    for (const item of other) lines.push(itemLine(item));
  }
  if (report.plans.length > 0) {
    lines.push(
      '',
      'Install plans (only the user can start these, from the Dependencies card in Wevir):',
    );
    for (const plan of report.plans) {
      const scripts = [
        plan.scripts.project.length > 0
          ? `project scripts: ${plan.scripts.project.join('; ')}`
          : undefined,
        `dependency scripts: ${plan.scripts.dependencies}`,
        plan.writesLockfile ? 'writes the lockfile' : undefined,
        ...plan.credentials
          .filter((credential) => credential.source === 'missing')
          .map((credential) => `credential ${credential.name} missing`),
      ].filter(Boolean);
      lines.push(
        `- \`${plan.command}\` in ${plan.path === '' ? '.' : plan.path} (${plan.reason}; ${scripts.join('; ')})`,
      );
    }
  }
  const network = report.network;
  if (network.registries.length > 0) {
    lines.push(
      '',
      `Registries: ${network.registries.map((registry) => `${registry.ecosystem} ${registry.url} (${registry.source}, auth ${registry.auth})`).join('; ')}.`,
    );
  }
  if (network.proxy.length > 0) lines.push(`Proxy settings present: ${network.proxy.join(', ')}.`);
  if (network.agent !== undefined) {
    const text =
      network.agent.network === 'sandboxed'
        ? 'your shell commands run in a sandbox without network access (a command that needs the network asks the user for approval)'
        : network.agent.network === 'unrestricted'
          ? 'your shell commands run without a sandbox and can reach the network'
          : network.agent.network === 'engine_managed'
            ? 'network access of your shell commands is decided by the engine’s own permissions'
            : 'network access of your shell commands is unknown';
    lines.push(`Network: ${text}. Nothing restricts traffic to package registry domains.`);
  }
  if (report.install !== undefined) {
    const install = report.install;
    lines.push(
      '',
      `Last install: \`${install.command}\` ${install.status}${install.reason ? ` (${install.reason})` : ''} at ${install.finishedAt ?? install.startedAt}.`,
    );
  }
  if (blocking.length > 0) {
    lines.push(
      '',
      'Do not change correct code to work around these. Tell the user what is missing; they can install dependencies from Wevir. Do not try to get around the sandbox to install them yourself.',
    );
  }
  return lines.join('\n');
}
