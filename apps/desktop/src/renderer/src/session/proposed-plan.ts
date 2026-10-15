// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/proposedPlan.ts（`buildCollapsedProposedPlanPreviewMarkdown`、
// `buildPlanImplementationPrompt`、`resolvePlanFollowUpSubmission`、`buildProposedPlanMarkdownFilename`、
// `normalizePlanMarkdownForExport`、`downloadPlanAsTextFile`）与 packages/shared/src/proposedPlanText.ts（`proposedPlanTitle`、
// `stripDisplayedPlanMarkdown`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：实施消息的前缀按界面语言（i18n 的 plan.implementPrefix，T3 是英文的 "PLEASE IMPLEMENT THIS PLAN:"）；文件名保留汉字等
// 非 ASCII 字母，只去掉文件名里不能用的字符；没有标题时的预览与新会话标题不要了。
//
// 计划卡片与“实施”（0.36.0，desktop-tokens §49）的纯逻辑：标题、折叠时的预览、实施消息、下载的文件名。

/** 计划的标题：第一个 Markdown 标题；没有时 null。 */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/** 卡片里显示的正文：去掉作为标题的第一行，以及紧跟着的“Summary”小标题。 */
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  const firstHeading = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeading?.[1]?.trim().toLowerCase() === 'summary') {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  }
  return sourceLines.join('\n');
}

/** 长计划要折叠：超过 900 个字符或 20 行。 */
export function planCollapsible(planMarkdown: string): boolean {
  return planMarkdown.length > 900 || planMarkdown.split('\n').length > 20;
}

/** 折叠时的预览：正文的前 `maxLines` 行有内容的行，后面还有时接一行 `...`。 */
export function collapsedPlanPreview(planMarkdown: string, maxLines = 10): string {
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const preview: string[] = [];
  let visible = 0;
  let more = false;
  for (const line of lines) {
    const isVisible = line.trim().length > 0;
    if (isVisible && visible >= maxLines) {
      more = true;
      break;
    }
    preview.push(line);
    if (isVisible) visible += 1;
  }
  while (preview.length > 0 && preview.at(-1)?.trim().length === 0) preview.pop();
  if (more) preview.push('', '...');
  return preview.join('\n');
}

/** “实施”发出的消息：前缀加整份计划。 */
export function planImplementationPrompt(prefix: string, planMarkdown: string): string {
  return `${prefix}\n${planMarkdown.trim()}`;
}

/**
 * 计划给出之后按发送（T3 的 `resolvePlanFollowUpSubmission`）：输入框有字时是“继续完善”，留在计划模式发这段字；空着时是
 * “实施”，回到默认模式发实施消息。
 */
export function planFollowUpSubmission(input: {
  draftText: string;
  planMarkdown: string;
  prefix: string;
}): { text: string; collaborationMode: 'default' | 'plan' } {
  const draft = input.draftText.trim();
  if (draft.length > 0) return { text: draft, collaborationMode: 'plan' };
  return {
    text: planImplementationPrompt(input.prefix, input.planMarkdown),
    collaborationMode: 'default',
  };
}

/** 下载的文件名：标题去掉文件名里不能用的字符，空白换成 `-`；没有标题时是 `plan.md`。 */
export function planFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown) ?? 'plan';
  const sanitized = title
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}<>:"/\\|?*#%&~]+/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${sanitized.length > 0 ? sanitized : 'plan'}.md`;
}

/** 导出的内容：去掉末尾空白，以一个换行结尾。 */
export function planFileContents(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

/** 以 Markdown 文件下载（浏览器的下载，Electron 会弹出保存位置）。 */
export function downloadPlan(planMarkdown: string): void {
  const blob = new Blob([planFileContents(planMarkdown)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = planFilename(planMarkdown);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
