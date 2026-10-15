/** 离边缘不超过这么多像素算到头（缩放后的小数像素）。 */
const EDGE_EPSILON_PX = 1;

export interface FadeEdges {
  /** 上面还能滚：顶部渐隐。 */
  top: boolean;
  /** 下面还能滚：底部渐隐。 */
  bottom: boolean;
}

/** 滚动边缘渐隐（scroll-fade.tsx）：哪一头还有内容没露出来，那一头就渐隐。 */
export function fadeEdges(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): FadeEdges {
  return {
    top: scrollTop > EDGE_EPSILON_PX,
    bottom: scrollHeight - scrollTop - clientHeight > EDGE_EPSILON_PX,
  };
}
