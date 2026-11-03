// 不挂起回合的提问（0.156.0，Codex 的 `request_user_input_async`，codex-event-mapping.md §6.6）：题目换成 Wevir 的 `UserQuestion`，
// 回答写成 Codex 认得的回复信封（codex-rs/context-fragments/src/answered_question.rs 与 tui/src/async_question_reply.rs：
// `<send_user_message_question_reply>` 里一个 JSON 数组，每项 `questionItemId`、`question`、`answer`）。题目 ID 照 Codex 桌面版：
// `JSON.stringify(["request_user_input_async", itemId, 题号])`。

import type { UserQuestion } from '@wevir/runtime-adapter';
import type { AsyncUserInputQuestion } from './protocol.js';

const TOOL = 'request_user_input_async';
const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';
/** 回复里的题目最多这么多字节（同 Codex 的 `AnsweredQuestion`），换行变空格。 */
const MAX_QUESTION_BYTES = 512;
/** 一题最多显示这么多选项，过长的选项不显示（同 Codex TUI）。 */
const MAX_OPTIONS = 32;
const MAX_OPTION_BYTES = 512;

/** Codex 的题目换成 `UserQuestion`；标题为空的题不要。没有选项的只能自己填。 */
export function asyncQuestions(itemId: string, questions: unknown[]): UserQuestion[] {
  return questions.flatMap((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const { title, options } = raw as Partial<AsyncUserInputQuestion>;
    if (typeof title !== 'string' || title.trim() === '') return [];
    const labels = Array.isArray(options)
      ? options
          .filter(
            (label): label is string =>
              typeof label === 'string' && label.trim() !== '' && bytes(label) <= MAX_OPTION_BYTES,
          )
          .slice(0, MAX_OPTIONS)
      : [];
    return [
      {
        id: JSON.stringify([TOOL, itemId, index]),
        question: title,
        options: [...new Set(labels)].map((label) => ({ label })),
        allowOther: true,
      },
    ];
  });
}

/** 回答写成回复信封；只写有回答的题，一题多个回答用换行连起来。 */
export function asyncAnswerText(
  questions: UserQuestion[],
  answers: Record<string, string[]>,
): string {
  const replies = questions.flatMap((question) => {
    const answer = (answers[question.id] ?? []).filter((item) => item.trim() !== '');
    if (answer.length === 0) return [];
    return [
      {
        answer: answer.join('\n'),
        question: truncateBytes(question.question, MAX_QUESTION_BYTES).replace(/[\r\n]/g, ' '),
        questionItemId: question.id,
      },
    ];
  });
  return `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (bytes(out) + bytes(char) > max) break;
    out += char;
  }
  return out;
}
