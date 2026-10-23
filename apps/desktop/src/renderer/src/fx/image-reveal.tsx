import { cn } from 'cn';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useReducedMotion } from './motion';

// 图片出现时的显现动画（U3，img-fx 的 sweep-gradient）。img-fx 依赖 three，只在第一次真的要显现图片时动态加载（Vite 拆成
// 单独的 chunk）。显现完换成普通的 <img>，不留 WebGL 实例；同一张图（`revealKey`）在本进程里只显现一次（分段渲染把回合挪
// 出去再挪回来、切走会话再回来都不重播）。减弱动效时直接显示图片。
//
// 0.118.0 起消息流里生成的图片用它（session/generated-image.tsx）：还没有 `src` 时只跑着色器表示“生成中”，图片到了在同一个
// 实例上显现。开发期的动效样张（fx/fx-gallery.tsx）也用它。

const ImageRevealEffect = lazy(() => import('./image-reveal-effect'));

const revealed = new Set<string>();

/** 圆角同控件（--radius-control）。img-fx 要显式给数值。 */
const RADIUS = 8;
/** 图片最高显示多少 px，宽度按比例收。 */
const MAX_HEIGHT = 360;

export interface ImageSize {
  width: number;
  height: number;
}

/** 显示的宽度（px）：不超过原图，高不超过 `MAX_HEIGHT`；还要再受容器宽度限制。没有像素时按正方形。 */
export function revealWidth(size: ImageSize | undefined): number {
  const { width, height } = size ?? { width: MAX_HEIGHT, height: MAX_HEIGHT };
  return Math.min(width, Math.round((MAX_HEIGHT * width) / height));
}

/** 按像素比例的外框：最宽不超过原图与容器，最高 `MAX_HEIGHT`。 */
function boxOf(size: ImageSize) {
  return {
    aspectRatio: `${size.width} / ${size.height}`,
    width: `min(100%, ${revealWidth(size)}px)`,
  };
}

export function ImageReveal({
  src,
  alt,
  size: known,
  revealKey = src,
  animate = true,
  className,
}: {
  /** 还没有时是“生成中”。 */
  src: string | undefined;
  alt: string;
  /** 已知的像素（生成的图片由 Host 读出）；没有时解码 `src` 得到，等待时按正方形。 */
  size?: ImageSize | undefined;
  /** 只显现一次的依据；默认 `src`。 */
  revealKey?: string | undefined;
  /** false 时直接显示图片（打开旧会话里早就生成好的图）。 */
  animate?: boolean;
  className?: string | undefined;
}) {
  const reduced = useReducedMotion();
  const [decoded, setDecoded] = useState<ImageSize>();
  const [done, setDone] = useState(() => revealKey !== undefined && revealed.has(revealKey));
  const size = known ?? decoded;

  useEffect(() => {
    if (src === undefined || known !== undefined) return;
    let cancelled = false;
    const image = new Image();
    image.src = src;
    image
      .decode()
      .then(() => {
        if (!cancelled) setDecoded({ width: image.naturalWidth, height: image.naturalHeight });
      })
      .catch(() => {
        // 解不开的图交给 <img> 自己显示坏图标，不放动画。
        if (!cancelled) setDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, known]);

  const surface = 'block rounded-lg bg-muted';
  const box = size
    ? boxOf(size)
    : src === undefined
      ? boxOf({ width: MAX_HEIGHT, height: MAX_HEIGHT })
      : undefined;
  const still = done || reduced || !animate;

  if (src !== undefined && (still || !box)) {
    if (!box && !still) {
      return <div className={cn(surface, 'aspect-[16/10] w-full max-w-md', className)} />;
    }
    return (
      <img
        src={src}
        alt={alt}
        data-image-reveal="static"
        className={cn('block max-w-full rounded-lg', className)}
        style={box}
      />
    );
  }
  if (src === undefined && reduced) {
    return (
      <div
        data-image-reveal="pending"
        role="img"
        aria-label={alt}
        aria-busy
        className={cn(surface, className)}
        style={box}
      />
    );
  }

  const finish = () => {
    if (revealKey !== undefined) revealed.add(revealKey);
    setDone(true);
  };
  return (
    <div
      data-image-reveal="effect"
      role="img"
      aria-label={alt}
      aria-busy={src === undefined}
      className={className}
      style={box}
    >
      <Suspense fallback={<div className={cn(surface, 'size-full')} />}>
        <ImageRevealEffect
          src={src}
          radius={RADIUS}
          className={cn(surface, 'size-full')}
          onRevealed={finish}
        />
      </Suspense>
    </div>
  );
}
