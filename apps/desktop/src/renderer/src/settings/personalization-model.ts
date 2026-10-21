// 设置 → 个性化（0.78.0，Host 功能 `agent_instructions`）的选项与会话侧栏卡片的行。

import type { OutputStyle, SessionCustomInstructions } from '@wevir/protocol';
import { isOutputStyle, OUTPUT_STYLES } from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

export const OUTPUT_STYLE_OPTIONS: readonly OutputStyle[] = ['default', ...OUTPUT_STYLES];

export const OUTPUT_STYLE_LABELS: Record<OutputStyle, PlainMessageKey> = {
  default: 'outputStyle.default',
  concise: 'outputStyle.concise',
  explanatory: 'outputStyle.explanatory',
  learning: 'outputStyle.learning',
  proactive: 'outputStyle.proactive',
  pragmatic: 'outputStyle.pragmatic',
  friendly: 'outputStyle.friendly',
};

/** 设置里的风格：省略与不认识的（更新的 Host 加的）按 `default` 显示。 */
export function globalStyle(value: string | undefined): OutputStyle {
  return value !== undefined && isOutputStyle(value) ? value : 'default';
}

/** 会话侧栏“个性化”卡片的一行。 */
export interface CustomRow {
  key: string;
  label: PlainMessageKey;
  value: PlainMessageKey;
}

/** 这个会话交给引擎的说明与风格，一项一行；不认识的风格不列。 */
export function customRows(custom: SessionCustomInstructions): CustomRow[] {
  const rows: CustomRow[] = [];
  if (custom.instructions) {
    rows.push({
      key: 'instructions',
      label: 'settings.personalization.instructions',
      value: 'rules.wevir',
    });
  }
  const style = custom.outputStyle;
  if (style !== undefined && isOutputStyle(style)) {
    rows.push({
      key: 'style',
      label: 'settings.personalization.outputStyle',
      value: OUTPUT_STYLE_LABELS[style],
    });
  }
  return rows;
}
