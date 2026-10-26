// 左栏项目的手动排序：按住项目标题拖动改顺序，右键菜单的上移、下移是同一个计算。置顶的项目仍排在前面，拖动只在它自己
// 那一段（置顶的或没置顶的）里换位置。不碰 DOM，单独测；DOM 与指针事件在 project-drag.tsx。

/**
 * 插到哪：指针过了第 i 个项目标题的中线就插在它后面。`midlines` 是去掉被拖的那一个之后各项目标题的中线，从上到下。
 * 展开的项目下面列着会话，指针在会话上时算在这个项目后面。
 */
export function projectInsertIndex(pointerY: number, midlines: readonly number[]): number {
  let index = 0;
  while (index < midlines.length && pointerY > (midlines[index] ?? 0)) index += 1;
  return index;
}

/**
 * 夹在被拖的项目所在的那一段里：置顶的只在置顶的之间，没置顶的不越到置顶的前面。`listed` 是左栏现在的顺序（置顶的在前），
 * `index` 是去掉被拖的那一个之后的插入位置。
 */
export function projectDropIndex(
  listed: readonly string[],
  pinned: readonly string[],
  id: string,
  index: number,
): number {
  const pinnedCount = listed.filter((other) => other !== id && pinned.includes(other)).length;
  const othersCount = listed.filter((other) => other !== id).length;
  return pinned.includes(id)
    ? Math.min(pinnedCount, Math.max(0, index))
    : Math.min(othersCount, Math.max(pinnedCount, index));
}

/** 把 `id` 挪到 `index`（去掉它之后的位置，按 `projectDropIndex` 夹好）；顺序没变时返回 `listed` 本身。 */
export function moveProject(
  listed: readonly string[],
  pinned: readonly string[],
  id: string,
  index: number,
): readonly string[] {
  if (!listed.includes(id)) return listed;
  const others = listed.filter((other) => other !== id);
  const at = projectDropIndex(listed, pinned, id, index);
  const next = [...others.slice(0, at), id, ...others.slice(at)];
  return next.every((other, i) => other === listed[i]) ? listed : next;
}
