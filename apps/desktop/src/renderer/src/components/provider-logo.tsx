import { cn } from 'cn';
import anthropic from '@/assets/provider-logos/anthropic.svg';
import antigravity from '@/assets/provider-logos/antigravity-color.svg';
import azure from '@/assets/provider-logos/azure-color.svg';
import claude from '@/assets/provider-logos/claude-color.svg';
import codex from '@/assets/provider-logos/codex-color.svg';
import cursor from '@/assets/provider-logos/cursor.svg';
import deepseek from '@/assets/provider-logos/deepseek-color.svg';
import gemini from '@/assets/provider-logos/gemini-color.svg';
import grok from '@/assets/provider-logos/grok.svg';
import kimi from '@/assets/provider-logos/kimi-color.svg';
import ollama from '@/assets/provider-logos/ollama.svg';
import openai from '@/assets/provider-logos/openai.svg';
import opencode from '@/assets/provider-logos/opencode.svg';
import qwen from '@/assets/provider-logos/qwen-color.svg';
import vertex from '@/assets/provider-logos/vertexai-color.svg';
import xai from '@/assets/provider-logos/xai.svg';
import zhipu from '@/assets/provider-logos/zhipu-color.svg';

/** 模型服务的标志（来源见 assets/provider-logos/SOURCE.md）。`mono` 的是单色字形，画成文字色。 */
const LOGOS = {
  openai: { src: openai, mono: true },
  anthropic: { src: anthropic, mono: true },
  gemini: { src: gemini, mono: false },
  vertex: { src: vertex, mono: false },
  azure: { src: azure, mono: false },
  deepseek: { src: deepseek, mono: false },
  qwen: { src: qwen, mono: false },
  kimi: { src: kimi, mono: false },
  zhipu: { src: zhipu, mono: false },
  xai: { src: xai, mono: true },
  ollama: { src: ollama, mono: true },
  // 订阅来源的软件标志（0.19.0）：模型选择与设置里用它区分“来自哪个订阅”与 API。
  codex: { src: codex, mono: false },
  claude: { src: claude, mono: false },
  cursor: { src: cursor, mono: true },
  opencode: { src: opencode, mono: true },
  grok: { src: grok, mono: true },
  antigravity: { src: antigravity, mono: false },
} as const;

export type ProviderLogoId = keyof typeof LOGOS;

/**
 * 单色的经 CSS 遮罩染成 `currentColor`（深浅色都看得见），彩色的用 `<img>` 原样显示；尺寸由 `className` 给（默认
 * size-5）。没有标志的服务（自定义）显示首字母。
 */
export function ProviderLogo({
  logo,
  fallback,
  className,
}: {
  logo: ProviderLogoId | undefined;
  /** 没有标志时显示的字（通常是服务名）。 */
  fallback?: string;
  className?: string;
}) {
  const entry = logo && LOGOS[logo];
  if (!entry) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[0.7em] font-semibold text-soft-foreground uppercase',
          className,
        )}
      >
        {fallback?.trim().charAt(0) ?? '?'}
      </span>
    );
  }
  if (entry.mono) {
    const mask = `url(${JSON.stringify(entry.src)}) center / contain no-repeat`;
    return (
      <span
        aria-hidden
        className={cn('block size-5 shrink-0 bg-current', className)}
        style={{ mask, WebkitMask: mask }}
      />
    );
  }
  return <img src={entry.src} alt="" aria-hidden className={cn('size-5 shrink-0', className)} />;
}
