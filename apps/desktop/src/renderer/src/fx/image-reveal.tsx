import { cn } from 'cn';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useReducedMotion } from './motion';

// 工具结果里的图片（截图等）出现时的显现动画（U3，img-fx 的 sweep-gradient）。img-fx 依赖 three，只在第一次真的要显现
// 图片时动态加载（Vite 拆成单独的 chunk）。显现完换成普通的 <img>，不留 WebGL 实例；同一张图在本进程里只显现一次
// （分段渲染把回合挪出去再挪回来、切走会话再回来都不重播）。减弱动效时直接显示图片。
//
// 协议现在还没有图片（ToolOutput 只有文本），接入点见 TODO.md；开发期的动效样张（fx/fx-gallery.tsx）用它。

const ImageRevealEffect = lazy(() => import('./image-reveal-effect'));

const revealed = new Set<string>();

/** 圆角同控件（--radius-control）。img-fx 要显式给数值。 */
const RADIUS = 8;
/** 图片最高显示多少 px，宽度按比例收。 */
const MAX_HEIGHT = 360;

interface Size {
  width: number;
  height: number;
}

export function ImageReveal({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState<Size>();
  const [done, setDone] = useState(() => revealed.has(src));

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.src = src;
    image
      .decode()
      .then(() => {
        if (!cancelled) setSize({ width: image.naturalWidth, height: image.naturalHeight });
      })
      .catch(() => {
        // 解不开的图交给 <img> 自己显示坏图标，不放动画。
        if (!cancelled) setDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const box = size && {
    aspectRatio: `${size.width} / ${size.height}`,
    width: `min(100%, ${size.width}px, ${Math.round((MAX_HEIGHT * size.width) / size.height)}px)`,
  };
  const surface = 'block rounded-lg bg-muted';

  if (done || reduced || !box) {
    if (!box && !done && !reduced) {
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

  const finish = () => {
    revealed.add(src);
    setDone(true);
  };
  return (
    <div data-image-reveal="effect" role="img" aria-label={alt} className={className} style={box}>
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
