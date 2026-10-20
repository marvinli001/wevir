// coding 评测的报告：JSON 按配置 × 样本 × 次数展开（每条运行记录原样保留），另给一张 Markdown 汇总表。缺用量的请求单列，
// 平均数只用报了用量的请求算。结论只描述“这组配置在这些样本上的表现”，不给模型贴等级。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvalConfig, RunRecord } from './harness.js';
import type { Sample } from './samples.js';

type Json = Record<string, unknown>;

export interface SampleSummary {
  runs: number;
  /** 环境不可用的运行（不进成功率的分母）。 */
  environmentUnavailable: number;
  /** 成功 / 可计的运行。 */
  success: string;
  roundTripOk: number;
  editOk: number;
  taskOk: number;
  editAttempts: number;
  editsApplied: number;
  shellEdits: number;
  patchFormatErrors: number;
  preimageMismatches: number;
  targetMissing: number;
  toolArgErrors: number;
  permissionDenied: number;
  toolOrGatewayFailures: number;
  unexpectedChanges: number;
  destructive: number;
  recoveredAfterRetry: number;
  unrecoveredEditFailures: number;
  possibleFalsePass: number;
  avgRequests: number;
  avgAgentRequests: number;
  medianWallMs: number;
  /** 报了用量的请求数 / 全部请求数。 */
  requestsWithUsage: string;
  /** 下游中断之后仍取到用量的请求数（基线的转发代理会丢这些请求的用量）。 */
  usageAfterDownstreamAbort: number;
  /** 只按报了用量的请求算的平均输入 token。 */
  avgInputPerReportedRequest: number | null;
  cachedShare: number | null;
}

const sum = (runs: RunRecord[], pick: (run: RunRecord) => number) =>
  runs.reduce((total, run) => total + pick(run), 0);

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

export function summarize(runs: RunRecord[]): SampleSummary {
  const counted = runs.filter((run) => run.environmentUnavailable === undefined);
  const requests = sum(runs, (run) => run.requests.total);
  const reported = sum(runs, (run) => run.requests.withUsage);
  const input = sum(runs, (run) => run.usage.input);
  const cached = sum(runs, (run) => run.usage.cachedInput);
  const c = (key: keyof RunRecord['counts']) => sum(runs, (run) => run.counts[key]);
  return {
    runs: runs.length,
    environmentUnavailable: runs.length - counted.length,
    success: `${counted.filter((run) => run.success).length}/${counted.length}`,
    roundTripOk: counted.filter((run) => run.layers.roundTrip.ok).length,
    editOk: counted.filter((run) => run.layers.edit.ok).length,
    taskOk: counted.filter((run) => run.layers.task.ok).length,
    editAttempts: c('editAttempts'),
    editsApplied: c('editsApplied'),
    shellEdits: c('shellEdits'),
    patchFormatErrors: c('patchFormatErrors'),
    preimageMismatches: c('preimageMismatches'),
    targetMissing: c('targetMissing'),
    toolArgErrors: c('toolArgErrors'),
    permissionDenied: c('permissionDenied'),
    toolOrGatewayFailures: c('toolOrGatewayFailures'),
    unexpectedChanges: c('unexpectedChanges'),
    destructive: c('destructive'),
    recoveredAfterRetry: c('recoveredAfterRetry'),
    unrecoveredEditFailures: c('unrecoveredEditFailures'),
    possibleFalsePass: runs.filter((run) => run.possibleFalsePass).length,
    avgRequests: runs.length === 0 ? 0 : Math.round((requests / runs.length) * 10) / 10,
    avgAgentRequests:
      runs.length === 0
        ? 0
        : Math.round((sum(runs, (run) => run.requests.agent) / runs.length) * 10) / 10,
    medianWallMs: median(runs.map((run) => run.wallMs)),
    requestsWithUsage: `${reported}/${requests}`,
    usageAfterDownstreamAbort: sum(runs, (run) => run.requests.usageAfterDownstreamAbort),
    avgInputPerReportedRequest: reported === 0 ? null : Math.round(input / reported),
    cachedShare: input === 0 ? null : Math.round((cached / input) * 1000) / 1000,
  };
}

export interface EvalReport {
  generatedAt: string;
  environment: Json;
  plan: Json;
  configs: Json[];
  samples: Array<{ id: string; group: string; covers: string; estimatedRequests: number }>;
  /** 配置 → 样本 → { runs, summary }。 */
  results: Record<string, Record<string, { runs: RunRecord[]; summary: SampleSummary }>>;
  /** 没在流里找到用量的请求（不进平均数）。 */
  missingUsage: Array<{
    config: string;
    sample: string;
    run: number;
    request: number;
    agent: boolean;
    reason: string;
  }>;
  notes: string[];
}

/** 配置的元数据（不含 Key）。 */
export function configInfo(config: EvalConfig, extra: Json): Json {
  return {
    id: config.id,
    model: config.model,
    providerKind: config.provider.kind,
    endpoint: config.endpoint,
    upstreamProtocol: config.upstreamProtocol,
    reasoningEffort: config.reasoningEffort ?? 'provider default',
    ...extra,
  };
}

export function newReport(
  environment: Json,
  plan: Json,
  configs: Json[],
  samples: readonly Sample[],
): EvalReport {
  return {
    generatedAt: new Date().toISOString(),
    environment,
    plan,
    configs,
    samples: samples.map((sample) => ({
      id: sample.id,
      group: sample.group,
      covers: sample.covers,
      estimatedRequests: sample.estimatedRequests,
    })),
    results: {},
    missingUsage: [],
    notes: [],
  };
}

export function addRun(report: EvalReport, run: RunRecord): void {
  const byConfig = report.results[run.config] ?? {};
  report.results[run.config] = byConfig;
  const entry = byConfig[run.sample] ?? { runs: [], summary: summarize([]) };
  byConfig[run.sample] = entry;
  entry.runs.push(run);
  entry.summary = summarize(entry.runs);
  for (const missing of run.missingUsage) {
    report.missingUsage.push({
      config: run.config,
      sample: run.sample,
      run: run.run,
      request: missing.request,
      agent: missing.agent,
      reason: missing.reason,
    });
  }
}

/** 写 JSON 与同名 .md；每跑完一次就写，中途停掉也不丢已经跑完的部分。 */
export function writeReport(report: EvalReport, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.replace(/\.json$/, '.md'), markdown(report));
}

const COLUMNS: Array<[string, (s: SampleSummary) => string | number]> = [
  ['成功', (s) => s.success],
  ['往返', (s) => s.roundTripOk],
  ['编辑', (s) => s.editOk],
  ['任务', (s) => s.taskOk],
  ['编辑尝试', (s) => s.editAttempts],
  ['格式错', (s) => s.patchFormatErrors],
  ['前置不符', (s) => s.preimageMismatches],
  ['目标缺失', (s) => s.targetMissing],
  ['参数错', (s) => s.toolArgErrors],
  ['权限拒绝', (s) => s.permissionDenied],
  ['工具/网关', (s) => s.toolOrGatewayFailures],
  ['非预期', (s) => s.unexpectedChanges],
  ['破坏', (s) => s.destructive],
  ['重试恢复', (s) => s.recoveredAfterRetry],
  ['疑似误报', (s) => s.possibleFalsePass],
  ['请求/次', (s) => s.avgRequests],
  ['耗时中位', (s) => `${Math.round(s.medianWallMs / 1000)} s`],
  ['有用量', (s) => s.requestsWithUsage],
  ['中断后取到', (s) => s.usageAfterDownstreamAbort],
  ['输入/请求', (s) => s.avgInputPerReportedRequest ?? '—'],
];

export function markdown(report: EvalReport): string {
  const out: string[] = [
    '# coding 评测汇总',
    '',
    `生成于 ${report.generatedAt}；${Object.entries(report.environment)
      .map(([key, value]) => `${key} ${String(value)}`)
      .join('；')}`,
    '',
    '结论只描述下列配置在这些样本上的表现，样本少，不代表模型的一般 coding 能力。',
    '',
    '## 配置',
    '',
    '| 配置 | 模型 | Provider | 上游协议 | 端点 | 工具预设 | 工具模式 | 力度 |',
    '|---|---|---|---|---|---|---|---|',
    ...report.configs.map(
      (config) =>
        `| ${config.id} | ${config.model} | ${config.providerKind} | ${config.upstreamProtocol} | ${config.endpoint} | ${config.toolPreset ?? '—'} | ${config.toolMode ?? '—'} | ${config.reasoningEffort ?? '—'} |`,
    ),
    '',
    '## 结果（配置 × 样本，每格是几次运行的合计）',
    '',
    `“成功”= 三层都过的次数 / 可计次数（环境不可用的不计）；“往返 / 编辑 / 任务”是各层通过的次数。`,
    '',
    `| 配置 | 样本 | ${COLUMNS.map(([name]) => name).join(' | ')} |`,
    `|---|---|${COLUMNS.map(() => '---').join('|')}|`,
  ];
  for (const [config, samples] of Object.entries(report.results)) {
    const all: RunRecord[] = [];
    for (const [sample, entry] of Object.entries(samples)) {
      all.push(...entry.runs);
      const env =
        entry.summary.environmentUnavailable > 0
          ? `（环境不可用 ${entry.summary.environmentUnavailable}）`
          : '';
      out.push(
        `| ${config} | ${sample}${env} | ${COLUMNS.map(([, pick]) => pick(entry.summary)).join(' | ')} |`,
      );
    }
    out.push(
      `| **${config}** | **合计** | ${COLUMNS.map(([, pick]) => `**${pick(summarize(all))}**`).join(' | ')} |`,
    );
  }
  out.push('', '## 失败实例', '');
  let any = false;
  for (const samples of Object.values(report.results)) {
    for (const entry of Object.values(samples)) {
      for (const run of entry.runs) {
        const failures = run.failures.filter(
          (failure) => !failure.category.endsWith('(recovered)'),
        );
        if (failures.length === 0 && !run.possibleFalsePass) continue;
        any = true;
        const items = failures
          .map(
            (failure) =>
              `${failure.category}${failure.file === undefined ? '' : ` ${failure.file}`}${failure.detail === undefined ? '' : `：${failure.detail.split('\n')[0]}`}`,
          )
          .join('；');
        out.push(
          `- ${run.config} / ${run.sample} #${run.run}${run.possibleFalsePass ? '（回答说完成了但验收没过）' : ''}${run.environmentUnavailable === undefined ? '' : `（环境不可用：${run.environmentUnavailable}）`}：${items || '—'}`,
        );
      }
    }
  }
  if (!any) out.push('（没有）');
  out.push('', '## 缺用量的请求（不进平均数）', '');
  if (report.missingUsage.length === 0) out.push('（没有）');
  for (const missing of report.missingUsage) {
    out.push(
      `- ${missing.config} / ${missing.sample} #${missing.run} 请求 ${missing.request}（${missing.agent ? 'Agent' : '辅助'}）：${missing.reason}`,
    );
  }
  if (report.notes.length > 0)
    out.push('', '## 备注', '', ...report.notes.map((note) => `- ${note}`));
  return `${out.join('\n')}\n`;
}
