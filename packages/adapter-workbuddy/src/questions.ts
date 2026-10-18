import type { UserQuestion } from '@wevir/runtime-adapter';
import { record } from './models.js';

/** 官方 ACP 问题 schema；普通 request_permission 的 rawInput 也用 questions 数组。 */
export function workBuddyQuestions(input: unknown): UserQuestion[] | undefined {
  const entries = record(input)?.questions;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const questions: UserQuestion[] = [];
  for (const [index, entry] of entries.entries()) {
    const fields = record(entry);
    if (
      typeof fields?.question !== 'string' ||
      !fields.question.trim() ||
      !Array.isArray(fields.options)
    )
      return undefined;
    const options = fields.options.flatMap((option) => {
      const data = record(option);
      return typeof data?.label === 'string' && data.label.trim()
        ? [
            {
              label: data.label,
              ...(typeof data.description === 'string' && { description: data.description }),
            },
          ]
        : [];
    });
    if (options.length === 0 || options.length !== fields.options.length) return undefined;
    const id = typeof fields.id === 'string' && fields.id.trim() ? fields.id : `q_${index}`;
    if (questions.some((question) => question.id === id)) return undefined;
    questions.push({
      id,
      question: fields.question,
      options,
      allowOther: true,
      ...(fields.multiSelect === true && { multiSelect: true }),
    });
  }
  return questions;
}
