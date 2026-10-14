/**
 * Wevir 的品牌主标（“共核”，几何取自 assets/icons/source/mark.svg）。颜色是 currentColor，调用方用 text-brand：
 * 浅色是金、深色是铂金（tokens.css 的 --brand）。旁边的字标与线性功能图标用文字色，不用品牌色（assets/icons/README.md）。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden className={className}>
      <path d="M8 2H22Q24 2 24 4V6L20 10H10Q8 10 8 12V18H12Q14 18 14 20V24H22Q24 24 24 22V12L28 8Q30 8 30 10V22Q30 30 22 30H10Q8 30 8 28V24H6Q2 24 2 20V8Q2 2 8 2Z" />
    </svg>
  );
}
