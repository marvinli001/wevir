import { styleText } from 'node:util';

export type Paint = (text: string) => string;

/** 终端颜色。只在输出流是 TTY 时着色，并遵守 NO_COLOR / FORCE_COLOR（`styleText` 的 `validateStream`）。 */
export interface Styles {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
}

export function stylesFor(stream: NodeJS.WritableStream): Styles {
  const paint =
    (format: Parameters<typeof styleText>[0]): Paint =>
    (text) =>
      styleText(format, text, { stream });
  return {
    bold: paint('bold'),
    dim: paint('dim'),
    red: paint('red'),
    green: paint('green'),
    yellow: paint('yellow'),
    cyan: paint('cyan'),
  };
}

/** 不着色（测试与非 TTY 时的效果相同）。 */
export const PLAIN: Styles = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
};
