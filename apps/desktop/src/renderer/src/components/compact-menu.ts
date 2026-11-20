/**
 * 紧凑菜单（照 Codex 的 Choose environment 菜单）：每项一行 28 px，左边 14 px 说明文字色的图标，名称后面是 12 px
 * 说明文字色的补充（路径、个数、原因），选中的右边一个 14 px 的勾。首页标题与环境栏的项目菜单、“此计算机 ▾”、
 * “选择环境 ▾”共用，给 `DropdownMenuItem` / `DropdownMenuRadioItem` 的 `className`；左边的图标用 `COMPACT_ICON`。
 */
const BASE = "h-7 gap-2 py-0 text-sm [&_svg:not([class*='size-'])]:size-3.5";

export const COMPACT_ITEM = `${BASE} px-2`;

/** 单选项右边给勾留位置。 */
export const COMPACT_RADIO_ITEM = `${BASE} pl-2 pr-7`;

export const COMPACT_DETAIL = 'min-w-0 flex-1 truncate text-xs text-muted-foreground';

export const COMPACT_ICON = 'text-muted-foreground';
