import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * 窗格内容放进窗格头的两处（desktop-layout.md §3.6）：`title` 换掉标题（只有一个标签、窗格头写标题时才有），`actions` 在
 * “更多”的左边。窗格头为它们各留一个空位，内容用 portal 放进去；标题位有东西时原来的标题藏起来。
 */
export interface PaneHeaderSlots {
  title: HTMLElement | null;
  actions: HTMLElement | null;
}

const PaneHeaderContext = createContext<PaneHeaderSlots>({ title: null, actions: null });

export const PaneHeaderProvider = PaneHeaderContext.Provider;

export function usePaneHeaderSlots(): PaneHeaderSlots {
  return useContext(PaneHeaderContext);
}

/** 放进窗格头的某一处；那一处没有（窗格头是标签条、不在窗格里）时不画，调用方自己在内容里画。 */
export function PaneHeaderPortal({
  slot,
  children,
}: {
  slot: keyof PaneHeaderSlots;
  children: ReactNode;
}) {
  const target = usePaneHeaderSlots()[slot];
  return target ? createPortal(children, target) : null;
}
