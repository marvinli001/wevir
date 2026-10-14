// 动效样张（U3）：把 libraries.dev 各库在静器里的封装摆在一页，开发模式下在 #/dev/fx，正式构建默认不带
// （VITE_WEVIR_FX_GALLERY=1 构建时才带，用来在生产 CSP 下核对效果，docs/development.md）。U4 要用的 MetalWordmark、
// MetalNewBadge 与协议还没接上的 ImageReveal 现在只在这里出现。

import type { PendingDelivery, SubagentStatus } from '@wevir/protocol';
import { ArrowUp, Square } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { t } from '@/i18n';
import { AVATAR_TYPES, avatarFor } from '@/session/avatar';
import { DeliverySwitch } from '@/session/delivery-switch';
import { SubagentAvatar } from '@/session/subagent-avatar';
import { setThemeMode } from '@/theme/theme';
import { Beam } from './beam';
import { ImageReveal } from './image-reveal';
import { MetalCircle, MetalNewBadge, MetalWordmark } from './metal';
import { useFxTheme, useReducedMotion } from './motion';
import { Orb } from './orb';
import { ORB_STATES } from './orb-state';

/** 每种形状挑一个会话 ID（avatar.ts 按哈希选形状）。 */
function idsByType(): string[] {
  const found = new Map<string, string>();
  for (let i = 0; found.size < AVATAR_TYPES.length && i < 500; i++) {
    const id = `ses_fxgallery${i.toString().padStart(4, '0')}`;
    const { type } = avatarFor(id);
    if (!found.has(type)) found.set(type, id);
  }
  return [...found.values()];
}

const AVATAR_STATUSES: SubagentStatus[] = ['running', 'completed', 'closed'];

/** 一张假截图（canvas 画的 data: URL，CSP 的 img-src 放行 data:）。`seed` 变了就是另一张图，可以再显现一次。 */
function makeShot(theme: 'light' | 'dark', seed: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const dark = theme === 'dark';
  ctx.fillStyle = dark ? '#17181c' : '#ffffff';
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = dark ? '#101114' : '#f7f6f3';
  ctx.fillRect(0, 0, 150, 400);
  const ink = dark ? '#9d9e9b' : '#67635a';
  ctx.fillStyle = ink;
  for (let i = 0; i < 7; i++) ctx.fillRect(20, 40 + i * 32, 90 - ((i * 13 + seed) % 40), 8);
  ctx.fillStyle = dark ? '#26282d' : '#f2f1ee';
  ctx.fillRect(180, 300, 430, 70);
  ctx.fillStyle = dark ? '#eeede8' : '#1a1a17';
  for (let i = 0; i < 5; i++) ctx.fillRect(180, 40 + i * 40, 360 - ((i * 47 + seed * 7) % 160), 10);
  ctx.fillStyle = dark ? '#c9b083' : '#9b7840';
  ctx.beginPath();
  ctx.arc(590, 60, 18 + (seed % 3) * 4, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL('image/png');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

export function FxGallery() {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  const [delivery, setDelivery] = useState<PendingDelivery>('steer');
  const [beamOn, setBeamOn] = useState(true);
  const [shot, setShot] = useState(1);
  const src = useMemo(() => makeShot(theme, shot), [theme, shot]);
  return (
    <div className="h-full overflow-y-auto" data-fx-gallery>
      <div className="mx-auto max-w-content space-y-4 px-6 py-8">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-medium">{t('fx.gallery.title')}</h1>
          <span className="text-xs text-muted-foreground">
            {theme} · {reduced ? 'prefers-reduced-motion' : 'motion'}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-lg border border-border px-2 py-1 text-xs"
            onClick={() => setThemeMode(theme === 'dark' ? 'light' : 'dark')}
          >
            {t('fx.gallery.toggleTheme')}
          </button>
        </header>

        <Section title="Thinking orbs">
          <ul className="flex flex-wrap gap-4">
            {ORB_STATES.map((state) => (
              <li key={state} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Orb state={state} />
                {state}
              </li>
            ))}
            <li className="flex items-center gap-2 text-xs text-muted-foreground">
              <Orb state="working" paused />
              paused
            </li>
          </ul>
        </Section>

        <Section title="Border beam">
          <div className="grid gap-4 sm:grid-cols-2">
            <Beam preset="composer" active={beamOn} className="block">
              <div className="rounded-xl border border-input bg-card px-3 py-6 text-sm text-muted-foreground">
                composer · line · mono · 0.8
              </div>
            </Beam>
            <Beam preset="approval" className="block">
              <div className="rounded-xl border border-warning/40 bg-card px-3 py-6 text-sm">
                approval · pulse-inner · gold
              </div>
            </Beam>
          </div>
          <button
            type="button"
            className="rounded-lg border border-border px-2 py-1 text-xs"
            onClick={() => setBeamOn(!beamOn)}
          >
            active: {String(beamOn)}
          </button>
        </Section>

        <Section title="Bot avatars">
          <div className="flex flex-wrap gap-5">
            {idsByType().map((id) => (
              <div key={id} className="flex items-center gap-2">
                {AVATAR_STATUSES.map((status) => (
                  <SubagentAvatar
                    key={status}
                    sessionId={id}
                    status={status}
                    size={28}
                    interactive
                  />
                ))}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Gooey">
          <DeliverySwitch value={delivery} onChange={setDelivery} />
        </Section>

        <Section title="Metal">
          <div className="flex flex-wrap items-center gap-6">
            <MetalCircle>
              <button
                type="button"
                aria-label={t('session.send')}
                className="flex size-8 items-center justify-center rounded-full"
              >
                <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
              </button>
            </MetalCircle>
            <MetalCircle strength={0.55}>
              <button
                type="button"
                aria-label={t('session.stop')}
                className="flex size-8 items-center justify-center rounded-full"
              >
                <Square aria-hidden className="size-3 fill-current" />
              </button>
            </MetalCircle>
            <MetalWordmark>Wevir</MetalWordmark>
            <MetalNewBadge>{t('fx.gallery.new')}</MetalNewBadge>
          </div>
        </Section>

        <Section title="Image · sweep-gradient">
          <ImageReveal key={src} src={src} alt={t('fx.gallery.shot')} />
          <button
            type="button"
            className="rounded-lg border border-border px-2 py-1 text-xs"
            onClick={() => setShot(shot + 1)}
          >
            {t('fx.gallery.replay')}
          </button>
        </Section>
      </div>
    </div>
  );
}
