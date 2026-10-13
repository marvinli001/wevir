// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/lib/tool-aggregate.ts、apps/app/src/lib/current-tool-lifecycle.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #6）。工具分类从 OpenCode 的工具名换成 Wevir 的展示类型（ToolDisplay.kind，
// domain-model §7），只聚合读取与搜索两类；聚合标题改为中文的“读取 N 个文件、搜索 N 次”（进行时 / 完成时）；
// 聚合内的思考按原顺序保留（同 AggregateThought 的做法）。“状态未知”规则照搬 current-tool-lifecycle：只有
// 回合仍在进行时未收尾的工具才算运行中，否则显示状态未知；另加“被拒绝”（同一 toolCallId 的审批被拒）。

import type { ChatPart, ChatPartOf } from '@wevir/client-sdk';

export type ToolPart = ChatPartOf<'tool'>;

/** 卡片上显示的状态。 */
export type ToolLifecycle =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'unknown';

/**
 * 工具卡片的状态。未收尾的工具只在所属回合仍在进行时算运行中 / 等待审批，否则是“状态未知”——不让一个
 * 停掉的回合留下一直转圈的卡片。审批被拒的工具显示“被拒绝”。
 */
export function toolLifecycle(part: ToolPart, turnActive: boolean): ToolLifecycle {
  if (part.status === 'running' || part.status === 'awaiting_approval') {
    return turnActive ? part.status : 'unknown';
  }
  if (part.approval?.status === 'denied' && part.status !== 'completed') return 'denied';
  return part.status;
}

export function isInFlight(lifecycle: ToolLifecycle): boolean {
  return lifecycle === 'running' || lifecycle === 'awaiting_approval';
}

/** 能聚合的工具：读取与搜索（连续多次时合成一张卡片）。 */
export function isAggregatable(part: ToolPart): boolean {
  return part.display.kind === 'read' || part.display.kind === 'search';
}

/** 一行参数摘要：路径、命令、查询词或 URL；都没有时取输入里的第一个字符串字段。 */
export function toolSummary(part: Pick<ToolPart, 'display' | 'input'>): string | undefined {
  const { display } = part;
  const summary =
    display.summary ??
    display.command ??
    (display.paths?.length ? display.paths.join(' ') : undefined) ??
    display.query ??
    display.url;
  if (summary) return firstLine(summary);
  if (isRecord(part.input)) {
    for (const value of Object.values(part.input)) {
      if (typeof value === 'string' && value.trim()) return firstLine(value);
    }
  }
  return undefined;
}

/** 结果摘要：输出的第一行非空文字。 */
export function outputSummary(part: ToolPart): string | undefined {
  const text = part.output?.text;
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim();
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── 聚合 ──────────────────────────────────────────────────────────────

/** 助手消息渲染时的一项：单个部件，或一串连续的读取 / 搜索。 */
export type PartItem =
  | { kind: 'part'; part: ChatPart }
  | {
      kind: 'aggregate';
      key: string;
      tools: ToolPart[];
      /** 按原顺序穿插在工具之间的思考。 */
      entries: Array<ToolPart | ChatPartOf<'reasoning'>>;
    };

/**
 * 把连续的读取 / 搜索（中间可以夹着思考）聚合成一项；少于 2 个工具的串原样展开。正文、其他工具、错误等
 * 一律打断聚合（同 OpenWork：模型的正文总是断开一组）。
 */
export function groupParts(parts: readonly ChatPart[]): PartItem[] {
  const items: PartItem[] = [];
  let run: Array<ToolPart | ChatPartOf<'reasoning'>> = [];

  const flush = () => {
    const tools = run.filter((entry): entry is ToolPart => entry.type === 'tool');
    // 串尾的思考不属于这一组（它在下一个动作之前）。
    let end = run.length;
    while (end > 0 && run[end - 1]?.type === 'reasoning') end -= 1;
    if (tools.length >= 2) {
      const entries = run.slice(0, end);
      items.push({ kind: 'aggregate', key: `g:${tools[0]?.key}`, tools, entries });
      for (const entry of run.slice(end)) items.push({ kind: 'part', part: entry });
    } else {
      for (const entry of run) items.push({ kind: 'part', part: entry });
    }
    run = [];
  };

  for (const part of parts) {
    if (part.type === 'tool' && isAggregatable(part) && part.status !== 'awaiting_approval') {
      run.push(part);
    } else if (part.type === 'reasoning' && run.length > 0) {
      run.push(part);
    } else {
      flush();
      items.push({ kind: 'part', part });
    }
  }
  flush();
  return items;
}

/** 聚合卡片的计数：读取按不同路径计文件数（没有路径时按调用次数），搜索按调用次数。 */
export function aggregateCounts(tools: readonly ToolPart[]): { files: number; searches: number } {
  const paths = new Set<string>();
  let reads = 0;
  let searches = 0;
  for (const tool of tools) {
    if (tool.display.kind === 'read') {
      reads += 1;
      for (const path of tool.display.paths ?? []) paths.add(path);
    } else {
      searches += 1;
    }
  }
  return { files: paths.size > 0 ? paths.size : reads, searches };
}
