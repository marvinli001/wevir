// 左栏拖动置顶的计算（照 Claude Code 桌面端）：按住会话行拖进“置顶”一组就置顶，组里拖动改顺序，把置顶的拖出组外
// 松开就取消置顶。不碰 DOM，单独测；DOM 与指针事件在 pin-drag.tsx。

/** 置顶组里一行占的高：行高 32 加行间 1（`h-8`、`space-y-px`）。 */
export const PIN_ROW_PITCH = 33;
/** 置顶组的命中区比组本身向下多出这么多，拖到组下沿附近也算。 */
export const PIN_ZONE_SLOP = 12;

export type PinDropTarget =
  /** 落在置顶组里：`index` 是去掉被拖的那一个之后的插入位置。 */
  | { kind: 'pin'; index: number }
  /** 置顶的会话被拖出组外：取消置顶。 */
  | { kind: 'unpin' }
  /** 没置顶的会话落在组外：什么都不变。 */
  | { kind: 'none' };

/**
 * 指针在置顶组里时插到哪：按每行不算让位时的中线，指针过了第 i 行的中线就插在它后面。不随当前的空位变，空位不会来回跳。
 * `listTop` 是组里列表的上沿，`count` 是去掉被拖的那一个之后的行数。
 */
export function pinInsertIndex(pointerY: number, listTop: number, count: number): number {
  const index = Math.floor((pointerY - listTop) / PIN_ROW_PITCH + 0.5);
  return Math.min(count, Math.max(0, index));
}

/** 指针在不在置顶组的命中区里：组的矩形，下沿多出 `PIN_ZONE_SLOP`。 */
export function inPinZone(
  pointer: { x: number; y: number },
  zone: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    pointer.x >= zone.left &&
    pointer.x <= zone.right &&
    pointer.y >= zone.top &&
    pointer.y <= zone.bottom + PIN_ZONE_SLOP
  );
}

export function dropTarget(over: boolean, index: number, wasPinned: boolean): PinDropTarget {
  if (over) return { kind: 'pin', index };
  return wasPinned ? { kind: 'unpin' } : { kind: 'none' };
}

/** 松开后的置顶列表（后置顶的在前，顺序就是组里的顺序）。 */
export function applyPinDrop(
  pinned: readonly string[],
  sessionId: string,
  target: PinDropTarget,
): readonly string[] {
  if (target.kind === 'none') return pinned;
  const others = pinned.filter((id) => id !== sessionId);
  if (target.kind === 'unpin') return others;
  const index = Math.min(others.length, Math.max(0, target.index));
  const next = [...others.slice(0, index), sessionId, ...others.slice(index)];
  return next.length === pinned.length && next.every((id, i) => id === pinned[i]) ? pinned : next;
}

export interface PinLayout {
  /** 每一行（按 `pinned` 的顺序）相对原位置的位移，单位是行。被拖的那一行移到空位上（它藏起来，空位由它占着）。 */
  shifts: readonly number[];
  /** 空位在第几格；没有空位时 undefined。 */
  gap: number | undefined;
  /** 列表一共占几格。 */
  slots: number;
}

/**
 * 拖动中置顶组怎么排：指针在组里时，其余各行在插入处让出一格；置顶的会话拖到组外时它原来那一格留空（照 Claude Code，
 * 松开才收拢）；没置顶的会话在组外时不让位。组是空的、正在拖时也留一格，好让人拖进来。
 */
export function pinLayout(
  pinned: readonly string[],
  drag: { sessionId: string; over: boolean; index: number } | undefined,
): PinLayout {
  if (!drag) return { shifts: pinned.map(() => 0), gap: undefined, slots: pinned.length };
  const from = pinned.indexOf(drag.sessionId);
  const othersCount = from === -1 ? pinned.length : pinned.length - 1;
  const gap = drag.over
    ? Math.min(othersCount, Math.max(0, drag.index))
    : from !== -1
      ? from
      : othersCount === 0
        ? 0
        : undefined;
  let other = 0;
  const shifts = pinned.map((id, natural) => {
    if (id === drag.sessionId) return gap === undefined ? 0 : gap - natural;
    const slot = other + (gap !== undefined && other >= gap ? 1 : 0);
    other += 1;
    return slot - natural;
  });
  return { shifts, gap, slots: othersCount + (gap === undefined ? 0 : 1) };
}
