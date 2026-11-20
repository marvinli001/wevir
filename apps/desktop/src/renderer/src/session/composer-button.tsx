import { Button } from '@/components/ui/button';
// 当前按钮外观取自 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/button/button.module.css
// SPDX-License-Identifier: MIT
// 改写自 kuratlielia/arc-library registry/components/button/button.tsx 与 button.module.css（primary 变体、按压、图标换场与加载）
// 来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99
// Copyright (c) 2026 Elia Kuratli
// 由 Wevir 修改：不用 motion 与 CSS modules，只留输入框主按钮要的圆形图标按钮。几个图标叠在同一格里用 CSS 过渡换场（Arc 的
// iconIn / iconOut：缩到 60%、糊 2 px、淡出 160 ms，进来的走 press 弹簧），按压用 theme.css 的 pressable（图标按钮按 Arc
// 缩到 96%），加载圈是 components/spinner.tsx 那一份；颜色用 Wevir 的令牌，减弱动效由 index.css 末尾的全局规则瞬时完成。

import { cn } from 'cn';
import { ArrowUp, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { composerPrefs, sendKeyLabel } from './composer-prefs';

export type ComposerAction = 'send' | 'refine' | 'stop' | 'steer' | 'queue' | 'redirect';

const ACTION_LABELS = {
  send: 'session.send',
  refine: 'plan.refine',
  stop: 'session.stop',
  steer: 'session.sendSteer',
  queue: 'session.sendQueue',
  redirect: 'session.sendRedirect',
} as const;

type Glyph = 'send' | 'stop' | 'loading';

/** 叠在同一格里的一个图标：在场时走 press 弹簧回到原样，离场时缩小、糊掉、淡出。 */
function Phase({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      data-on={on || undefined}
      className={cn(
        'flex items-center justify-center transition-[opacity,scale,filter]',
        on
          ? 'duration-(--spring-press-duration) ease-spring-press'
          : 'scale-60 opacity-0 blur-[2px] duration-160 ease-smooth',
      )}
    >
      {children}
    </span>
  );
}

/**
 * 输入框的主按钮（照 Arc 的 primary 按钮）：前景色的实心圆，悬停略淡并带一层静止阴影，按下更淡、缩到 96%。发送与停止之间
 * 图标原地换场；`loading`（消息已交出、Host 还没接住，例如新会话正在启动引擎）时换成加载圈，按钮仍可聚焦、点了不起作用。
 */
export function ComposerButton({
  action,
  loading = false,
  disabled,
  onClick,
}: {
  action: ComposerAction;
  loading?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = t(ACTION_LABELS[action]);
  const glyph: Glyph = loading ? 'loading' : action === 'stop' ? 'stop' : 'send';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon"
            type="button"
            aria-label={label}
            aria-busy={loading || undefined}
            aria-disabled={loading || undefined}
            disabled={disabled}
            data-composer-action={action}
            onClick={loading ? undefined : onClick}
            className="rounded-full"
          />
        }
      >
        <span className="grid place-items-center *:[grid-area:1/1]">
          <Phase on={glyph === 'send'}>
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </Phase>
          <Phase on={glyph === 'stop'}>
            <Square className="size-3 fill-current" />
          </Phase>
          <Phase on={glyph === 'loading'}>
            {glyph === 'loading' && (
              <span className="size-3.5 animate-[spin_0.7s_linear_infinite] rounded-full border-[1.5px] border-current border-r-transparent" />
            )}
          </Phase>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <kbd className="ml-1.5 font-sans opacity-70">
          {action === 'stop' ? 'Esc' : sendKeyLabel(composerPrefs.get().sendShortcut)}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}
