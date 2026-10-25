import { cn } from 'cn';
import anthropic from '@/assets/provider-logos/anthropic.svg';
import antigravity from '@/assets/provider-logos/antigravity-color.svg';
import azure from '@/assets/provider-logos/azure-color.svg';
import bedrock from '@/assets/provider-logos/bedrock-color.svg';
import claude from '@/assets/provider-logos/claude-color.svg';
import codebuddy from '@/assets/provider-logos/codebuddy-color.svg';
import codex from '@/assets/provider-logos/codex-color.svg';
import cursor from '@/assets/provider-logos/cursor.svg';
import deepseek from '@/assets/provider-logos/deepseek-color.svg';
import devin from '@/assets/provider-logos/devin-color.svg';
import fireworks from '@/assets/provider-logos/fireworks.svg';
import gemini from '@/assets/provider-logos/gemini-color.svg';
import copilot from '@/assets/provider-logos/githubcopilot.svg';
import grok from '@/assets/provider-logos/grok.svg';
import groq from '@/assets/provider-logos/groq.svg';
import kimi from '@/assets/provider-logos/kimi-color.svg';
import kimiLight from '@/assets/provider-logos/kimi-color-light.svg';
import minimax from '@/assets/provider-logos/minimax-color.svg';
import ollama from '@/assets/provider-logos/ollama.svg';
import openai from '@/assets/provider-logos/openai.svg';
import opencode from '@/assets/provider-logos/opencode.svg';
import openrouter from '@/assets/provider-logos/openrouter.svg';
import qwen from '@/assets/provider-logos/qwen-color.svg';
import stepfun from '@/assets/provider-logos/stepfun-color.svg';
import tencent from '@/assets/provider-logos/tencentcloud-color.svg';
import vercel from '@/assets/provider-logos/vercel.svg';
import vertex from '@/assets/provider-logos/vertexai-color.svg';
import volcengine from '@/assets/provider-logos/volcengine-color.svg';
import xai from '@/assets/provider-logos/xai.svg';
import mimo from '@/assets/provider-logos/xiaomimimo.svg';
import zai from '@/assets/provider-logos/zai.svg';
import zhipu from '@/assets/provider-logos/zhipu-color.svg';

interface LogoEntry {
  src: string;
  mono: boolean;
  light?: string;
}

/**
 * 模型服务的标志（来源见 assets/provider-logos/SOURCE.md）。`mono` 的是单色字形，画成文字色；彩色的有 `light` 时浅色主题用它
 * （原图有为深色底画的白色部分）。
 */
const LOGOS = {
  openai: { src: openai, mono: true },
  anthropic: { src: anthropic, mono: true },
  gemini: { src: gemini, mono: false },
  vertex: { src: vertex, mono: false },
  azure: { src: azure, mono: false },
  bedrock: { src: bedrock, mono: false },
  deepseek: { src: deepseek, mono: false },
  qwen: { src: qwen, mono: false },
  kimi: { src: kimi, mono: false, light: kimiLight },
  mimo: { src: mimo, mono: true },
  minimax: { src: minimax, mono: false },
  tencent: { src: tencent, mono: false },
  stepfun: { src: stepfun, mono: false },
  zhipu: { src: zhipu, mono: false },
  zai: { src: zai, mono: true },
  xai: { src: xai, mono: true },
  ollama: { src: ollama, mono: true },
  openrouter: { src: openrouter, mono: true },
  vercel: { src: vercel, mono: true },
  groq: { src: groq, mono: true },
  fireworks: { src: fireworks, mono: true },
  volcengine: { src: volcengine, mono: false },
  // 订阅来源的软件标志（0.19.0）：模型选择与设置里用它区分“来自哪个订阅”与 API。
  codex: { src: codex, mono: false },
  codebuddy: { src: codebuddy, mono: false },
  claude: { src: claude, mono: false },
  cursor: { src: cursor, mono: true },
  opencode: { src: opencode, mono: true },
  grok: { src: grok, mono: true },
  antigravity: { src: antigravity, mono: false },
  devin: { src: devin, mono: false },
  copilot: { src: copilot, mono: true },
} satisfies Record<string, LogoEntry>;

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
  const entry: LogoEntry | undefined = logo ? LOGOS[logo] : undefined;
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
  if (entry.light !== undefined) {
    return (
      <>
        <img
          src={entry.light}
          alt=""
          aria-hidden
          className={cn('size-5 shrink-0 dark:hidden', className)}
        />
        <img
          src={entry.src}
          alt=""
          aria-hidden
          className={cn('hidden size-5 shrink-0 dark:inline', className)}
        />
      </>
    );
  }
  return <img src={entry.src} alt="" aria-hidden className={cn('size-5 shrink-0', className)} />;
}
