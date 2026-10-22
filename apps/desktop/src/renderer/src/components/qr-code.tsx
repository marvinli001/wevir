import { cn } from 'cn';
import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * 二维码（uqr 编码，MIT）：一条 SVG 路径，每个深色模块一个 1×1 的方块，四周留 4 个模块的静区。不随主题变色：深浅主题都是白底黑块，
 * 手机相机才扫得出。
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  /** 读屏用的名称。 */
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 4 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      // 主题把调色板清空了，没有 `bg-white`；白底直接写死。
      style={{ backgroundColor: '#fff' }}
      className={cn('rounded-lg', className)}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
