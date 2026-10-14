// img-fx 的 sweep-gradient 显现（U3）。本文件连同 img-fx 与 three（几百 KB）只经 image-reveal.tsx 的动态 import 加载：
// 消息流里出现图片时才有这个 chunk 的请求。

import { ImageGeneration, type ImageGenerationHandle } from 'img-fx';
import { useEffect, useRef } from 'react';
import { useFxTheme } from './motion';

/** 显现结束后图片在 img-fx 里停留的时长：足够长，image-reveal.tsx 在进入 visible 时就换成普通的 <img>。 */
const HOLD_MS = 60 * 60 * 1000;

export default function ImageRevealEffect({
  src,
  radius,
  className,
  onRevealed,
}: {
  src: string;
  radius: number;
  className?: string;
  onRevealed: () => void;
}) {
  const theme = useFxTheme();
  const ref = useRef<ImageGenerationHandle>(null);
  const done = useRef(onRevealed);
  done.current = onRevealed;

  useEffect(() => {
    // 先让着色器跑一小会儿（“生成中”），再显现。
    const timer = window.setTimeout(() => ref.current?.triggerReveal({ hold: 'manual' }), 360);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <ImageGeneration
      ref={ref}
      preset="sweep-gradient"
      images={[src]}
      theme={theme}
      borderRadius={radius}
      revealHoldMs={HOLD_MS}
      onCycle={(event) => event.phase === 'visible' && done.current()}
      className="image-reveal"
    >
      <div className={className} />
    </ImageGeneration>
  );
}
