import { cn } from 'cn';
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import type { FilePreview, PreviewLine } from './file-preview-model';
import { relativeToRoot } from './tool-model';

/** 一个文件最多画出的行数，其余写“另有 N 行”（输入里的字符串已被 Host 截到 16 KB 以内，这里只防行很多的短行）。 */
const MAX_LINES = 400;

// 颜色同“变更”窗格（desktop-tokens.md §33）：增删的行底是代码底混 12% 的成功色 / 失败色，行号格混 20%，左边一道 2 px 的竖条。
const ROW_TONES: Record<PreviewLine['kind'], string> = {
  add: 'bg-[color-mix(in_srgb,var(--code-background)_88%,var(--success))]',
  remove: 'bg-[color-mix(in_srgb,var(--code-background)_88%,var(--destructive))]',
  context: '',
};
const GUTTER_TONES: Record<PreviewLine['kind'], string> = {
  add: 'bg-[color-mix(in_srgb,var(--code-background)_80%,var(--success))] shadow-[inset_2px_0_var(--success)]',
  remove:
    'bg-[color-mix(in_srgb,var(--code-background)_80%,var(--destructive))] shadow-[inset_2px_0_var(--destructive)]',
  context: 'bg-(--code-background)',
};

/** 渐隐的范围：内容超出时，上面还有内容就顶部渐隐，下面还有就底部渐隐。 */
const FADES = {
  top: 'linear-gradient(to bottom, transparent, black 2rem)',
  bottom: 'linear-gradient(to top, transparent, black 2rem)',
  both: 'linear-gradient(to bottom, transparent, black 2rem, black calc(100% - 2rem), transparent)',
} as const;

/**
 * 一个文件的预览（§56，照 Codex 桌面端）：标题行是路径（相对工作目录），下面是带行号的代码，新增与删除的行有底色与左边的
 * 竖条；最高 240 px，内部滚动，按滚动位置顶部或底部渐隐。只是预览，不做语法高亮。
 */
export function FilePreviewBlock({ preview, root }: { preview: FilePreview; root?: string }) {
  const lines = preview.lines.slice(0, MAX_LINES);
  const rest = preview.lines.length - lines.length;
  const numbered = lines.some((line) => line.number !== undefined);
  const digits = String(Math.max(0, ...lines.map((line) => line.number ?? 0))).length;
  const path = relativeToRoot(preview.path, root);
  const { ref, fade, onScroll } = useScrollFade();
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-(--code-background)"
      data-file-preview
    >
      {path && (
        <h4
          className="truncate border-b border-border px-3 py-1 font-mono text-xs text-muted-foreground"
          title={path}
        >
          {path}
        </h4>
      )}
      <div
        ref={ref}
        onScroll={onScroll}
        className="max-h-60 overflow-auto"
        style={fade ? { maskImage: FADES[fade] } : undefined}
        data-fade={fade}
      >
        <div className="w-max min-w-full py-1 font-mono text-xs leading-5">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行只按位置区分，内容变了整段重画。
            <Fragment key={index}>
              {line.gap && (
                <div className="flex text-muted-foreground" aria-hidden>
                  <Gutter numbered={numbered} digits={digits} className={GUTTER_TONES.context} />
                  <span className="px-3">⋯</span>
                </div>
              )}
              <div className={cn('flex', ROW_TONES[line.kind])} data-preview-line={line.kind}>
                <Gutter numbered={numbered} digits={digits} className={GUTTER_TONES[line.kind]}>
                  {line.number}
                </Gutter>
                <span className="pr-4 pl-3 whitespace-pre text-foreground">{line.text || ' '}</span>
              </div>
            </Fragment>
          ))}
          {rest > 0 && (
            <div className="flex text-muted-foreground">
              <Gutter numbered={numbered} digits={digits} className={GUTTER_TONES.context} />
              <span className="px-3">{t('tool.previewMore', { count: rest })}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** 行号格：横向滚动时留在左边；没有行号（替换一段文字）时只留竖条的位置。 */
function Gutter({
  numbered,
  digits,
  className,
  children,
}: {
  numbered: boolean;
  digits: number;
  className: string;
  children?: number | undefined;
}) {
  return (
    <span
      className={cn(
        'sticky left-0 shrink-0 text-right text-muted-foreground tabular-nums select-none',
        numbered ? 'pr-2 pl-3' : 'w-1',
        className,
      )}
      style={numbered ? { width: `calc(${digits}ch + 1.25rem)` } : undefined}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** 滚动容器的渐隐：挂上、内容变化与滚动时按位置重算。 */
function useScrollFade() {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<keyof typeof FADES>();
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const above = element.scrollTop > 0;
    const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setFade(above && below ? 'both' : above ? 'top' : below ? 'bottom' : undefined);
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    measure();
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  return { ref, fade, onScroll: measure };
}
