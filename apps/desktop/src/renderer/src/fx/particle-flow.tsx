import { cn } from 'cn';
import { useEffect, useRef } from 'react';
import { useReducedMotion } from './motion';

/**
 * 思考力度滑块已选那一段里的流动粒子（照 Codex 桌面端）：细小的白点从左往右慢慢漂，各自明暗闪烁，出右边后从左边换一个高度再进来。
 * 铺满父元素（父元素要定位），由父元素裁出可见的一段；画布按设备像素比画。`active` 为 false 或窗口隐藏时不画；减弱动效时只画一帧静止的点。
 */
export function ParticleFlow({
  active = true,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !active) return;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame = 0;
    let last = 0;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      particles = Array.from({ length: Math.round(width / PIXELS_PER_PARTICLE) }, () =>
        spawn(Math.random() * width, height),
      );
      if (reduced) draw(0);
    };
    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#ffffff';
      for (const particle of particles) {
        const twinkle = 0.55 + 0.45 * Math.sin(time * particle.rate + particle.phase);
        context.globalAlpha = particle.alpha * twinkle;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      }
    };
    const tick = (now: number) => {
      const seconds = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      for (const particle of particles) {
        particle.x += particle.speed * seconds;
        if (particle.x - particle.radius > width)
          Object.assign(particle, spawn(-particle.radius, height));
      }
      draw(now / 1000);
      frame = requestAnimationFrame(tick);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    if (!reduced) frame = requestAnimationFrame(tick);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 size-full transition-opacity duration-200',
        !active && 'opacity-0',
        className,
      )}
    />
  );
}

/** 每多少像素宽放一颗。 */
const PIXELS_PER_PARTICLE = 5;

interface Particle {
  x: number;
  y: number;
  radius: number;
  /** 每秒往右漂的像素。 */
  speed: number;
  alpha: number;
  rate: number;
  phase: number;
}

function spawn(x: number, height: number): Particle {
  return {
    x,
    y: 3 + Math.random() * Math.max(0, height - 6),
    radius: 0.4 + Math.random() * 0.7,
    speed: 5 + Math.random() * 14,
    alpha: 0.3 + Math.random() * 0.6,
    rate: 1.5 + Math.random() * 3,
    phase: Math.random() * Math.PI * 2,
  };
}
