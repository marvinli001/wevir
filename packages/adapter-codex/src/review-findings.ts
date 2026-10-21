// Codex 审查结果的文字拆回结构化的发现（0.83.0，codex-event-mapping.md §4.9）。
//
// app-server 的 `exitedReviewMode` item 与随后的助手消息只给文字：Codex 把审查子 agent 的 JSON（ReviewOutputEvent）用
// codex-rs/protocol/src/review_format.rs 的 `render_review_output_text` 渲染成“总体说明 + 发现列表”，严重度与把握只剩标题里的
// `[P1]` 标签。格式是固定的：
//
//   <总体说明>
//
//   Full review comments:        （只有一条时是 `Review comment:`）
//
//   - [P1] <标题> — <绝对路径>:<起>-<止>
//     <说明，每行缩进两个空格>
//
// 拆不出来（模型没按 JSON 输出、Codex 改了格式）时返回 undefined，适配器照原样报出消息。

/** 拆出的一条发现：`path` 是 Codex 给的原样（绝对路径）。 */
export interface CodexReviewFinding {
  title: string;
  body: string;
  priority?: number;
  path: string;
  startLine: number;
  endLine: number;
}

export interface CodexReview {
  /** 总体说明；没有时是空串。 */
  summary: string;
  findings: CodexReviewFinding[];
}

const HEADERS = new Set(['Full review comments:', 'Review comment:']);
const LOCATION = /^(.+):(\d+)-(\d+)$/;
const PRIORITY_TAG = /^\[P([0-3])\]\s*/;

export function parseCodexReview(text: string): CodexReview | undefined {
  const lines = text.split('\n');
  let header = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (HEADERS.has(lines[index] ?? '') && (index === 0 || lines[index - 1] === '')) {
      header = index;
      break;
    }
  }
  if (header < 0) return undefined;
  const findings: CodexReviewFinding[] = [];
  let body: string[] | undefined;
  const close = () => {
    const finding = findings.at(-1);
    if (finding && body) finding.body = body.join('\n').trim();
    body = undefined;
  };
  for (const line of lines.slice(header + 1)) {
    if (line === '') {
      close();
      continue;
    }
    if (line.startsWith('- ')) {
      close();
      const finding = parseHead(line.slice(2));
      if (!finding) return undefined;
      findings.push(finding);
      body = [];
      continue;
    }
    // 说明的每一行缩进两个空格（空行是两个空格）；说明之外的行说明格式不对。
    if (!line.startsWith('  ') || !body) return undefined;
    body.push(line.slice(2));
  }
  close();
  if (findings.length === 0) return undefined;
  return { summary: lines.slice(0, header).join('\n').trim(), findings };
}

/** `<标题> — <路径>:<起>-<止>`：标题里也可能有破折号，按最后一个分开。 */
function parseHead(head: string): CodexReviewFinding | undefined {
  const separator = head.lastIndexOf(' — ');
  if (separator < 0) return undefined;
  const match = LOCATION.exec(head.slice(separator + 3));
  if (!match) return undefined;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  let title = head.slice(0, separator).trim();
  let priority: number | undefined;
  const tag = PRIORITY_TAG.exec(title);
  if (tag) {
    priority = Number(tag[1]);
    title = title.slice(tag[0].length).trim();
  }
  if (title === '') return undefined;
  return {
    title,
    body: '',
    ...(priority !== undefined && { priority }),
    path: match[1] as string,
    // Codex 的行号从 1 起；模型偶尔给 0 或反过来的范围。
    startLine: Math.max(1, Math.min(startLine, endLine)),
    endLine: Math.max(1, startLine, endLine),
  };
}
