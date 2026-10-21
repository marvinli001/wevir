// 插件市场的认证徽章（plugin-market.md §9.3）：波浪边圆章里一个勾，verified 蓝、official 金（设计令牌 --verified / --official，
// tokens.test.ts 核对对比度）；悬停或键盘聚焦弹出卡片，照 X 的认证说明列出审核、发布者、认证时间、上游与备注。

import { PreviewCard } from '@base-ui/react/preview-card';
import type { MarketUpstream, MarketVerification } from '@wevir/protocol';
import { cn } from 'cn';
import { CalendarCheck, GitFork, Info, ShieldCheck, UserCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { currentLocale, t } from '@/i18n';
import {
  localizedName,
  upstreamLabel,
  VERIFICATION_LABEL,
  verificationMonth,
} from './market-model';

/** 圆章的轮廓：半径按 cos(8θ) 起伏的圆，八个圆润的波峰（viewBox 24）。 */
export const BADGE_PATH = (() => {
  const steps = 96;
  const points = Array.from({ length: steps }, (_, step) => {
    const angle = (step / steps) * Math.PI * 2;
    const radius = 10.9 + 1.1 * Math.cos(8 * angle);
    return `${(12 + radius * Math.sin(angle)).toFixed(2)} ${(12 - radius * Math.cos(angle)).toFixed(2)}`;
  });
  return `M${points.join('L')}Z`;
})();

const SIZES = { sm: 'size-3.5', lg: 'size-4.5' } as const;

const TONES = {
  verified: { fill: 'fill-verified', mark: 'stroke-verified-foreground' },
  official: { fill: 'fill-official', mark: 'stroke-official-foreground' },
} as const;

/** 只有图形：列表行与详情头的名字旁边用 `VerificationBadge`（带卡片），这里给卡片标题与测试。 */
export function BadgeMark({
  level,
  size = 'sm',
  className,
}: {
  level: MarketVerification['level'];
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const tone = TONES[level];
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn('shrink-0', SIZES[size], className)}
      data-badge={level}
    >
      <path d={BADGE_PATH} className={tone.fill} />
      <path
        d="M7.6 12.4l3.1 3.1 5.8-6.3"
        fill="none"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={tone.mark}
      />
    </svg>
  );
}

/** 名称右边的徽章：聚焦得到（Tab），悬停或聚焦时弹出认证说明。 */
export function VerificationBadge({
  verification,
  upstream,
  size = 'sm',
  className,
}: {
  verification: MarketVerification;
  upstream?: MarketUpstream;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const label = t(VERIFICATION_LABEL[verification.level]);
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={250}
        closeDelay={150}
        render={
          // 用按钮：键盘聚焦得到，聚焦时同样弹出认证说明；点它不做别的。
          <button
            type="button"
            aria-label={label}
            className={cn(
              'relative inline-flex shrink-0 rounded-full outline-none focus-visible:focus-ring',
              className,
            )}
            data-verification={verification.level}
          />
        }
      >
        <BadgeMark level={verification.level} size={size} />
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <PreviewCard.Popup
            className="z-50 w-72 origin-(--transform-origin) rounded-xl bg-popover p-3.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:duration-(--spring-reveal-duration) data-open:ease-spring-reveal data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-110 data-closed:ease-smooth"
            data-testid="verification-card"
          >
            <VerificationCard verification={verification} upstream={upstream} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/** 卡片的内容（没有按钮）。 */
export function VerificationCard({
  verification,
  upstream,
}: {
  verification: MarketVerification;
  upstream?: MarketUpstream;
}) {
  const locale = currentLocale();
  const note = verification.note && localizedName(verification.note, locale, '');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 font-medium">
        <BadgeMark level={verification.level} size="lg" />
        {t(VERIFICATION_LABEL[verification.level])}
      </div>
      <ul className="space-y-2 text-soft-foreground">
        <CardLine icon={<ShieldCheck />}>{t('plugins.market.badge.reviewed')}</CardLine>
        {verification.level === 'verified' && (
          <CardLine icon={<UserCheck />}>
            {t('plugins.market.badge.publisher', { publisher: verification.publisher })}
          </CardLine>
        )}
        <CardLine icon={<CalendarCheck />}>
          {t('plugins.market.badge.since', {
            month: verificationMonth(verification.since, locale),
          })}
        </CardLine>
        {upstream && (
          <CardLine icon={<GitFork />}>
            {t('plugins.market.badge.upstream', { project: upstreamLabel(upstream.url) })}
          </CardLine>
        )}
        {note && <CardLine icon={<Info />}>{note}</CardLine>}
      </ul>
    </div>
  );
}

function CardLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden
        className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4 [&_svg]:stroke-[1.75]"
      >
        {icon}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}
