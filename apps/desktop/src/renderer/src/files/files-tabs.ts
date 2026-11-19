// “文件”窗格里打开的文件（照 Claude Code 桌面端的 Files 面板）：窗格顶上一行是打开的文件，下面是当前文件的预览与文件树。
// 开着“预览标签页”时单击树里的文件只换掉预览中的那一个（斜体），双击或双击标签才固定下来；关掉时每次单击都新开一个标签。
// 只在本次运行内记住，按文件范围（files-data.ts 的 scopeKey）分开。

export interface OpenFiles {
  readonly paths: readonly string[];
  readonly active?: string;
  /** 预览中的那个标签：下一次单击别的文件时被换掉。 */
  readonly preview?: string;
}

export const NO_OPEN_FILES: OpenFiles = { paths: [] };

/** 打开一个文件：已开着就切过去（`pin` 时顺带固定）；`preview` 时换掉原来预览中的那个，否则新开一个固定的标签。 */
export function openPath(
  state: OpenFiles,
  path: string,
  options: { preview: boolean; pin?: boolean },
): OpenFiles {
  if (state.paths.includes(path)) {
    const unpin = options.pin && state.preview === path;
    return {
      paths: state.paths,
      active: path,
      ...(state.preview !== undefined && !unpin && { preview: state.preview }),
    };
  }
  const asPreview = options.preview && !options.pin;
  if (asPreview && state.preview !== undefined) {
    return {
      paths: state.paths.map((candidate) => (candidate === state.preview ? path : candidate)),
      active: path,
      preview: path,
    };
  }
  const at = state.active === undefined ? -1 : state.paths.indexOf(state.active);
  const paths =
    at === -1
      ? [...state.paths, path]
      : [...state.paths.slice(0, at + 1), path, ...state.paths.slice(at + 1)];
  return {
    paths,
    active: path,
    ...(asPreview ? { preview: path } : state.preview !== undefined && { preview: state.preview }),
  };
}

/** 固定预览中的标签。 */
export function pinPath(state: OpenFiles, path: string): OpenFiles {
  if (state.preview !== path) return state;
  return { paths: state.paths, ...(state.active !== undefined && { active: state.active }) };
}

/** 关掉一个标签；关的是当前的就切到它右边的，没有就左边的。 */
export function closePath(state: OpenFiles, path: string): OpenFiles {
  const at = state.paths.indexOf(path);
  if (at === -1) return state;
  const paths = state.paths.filter((candidate) => candidate !== path);
  const active = state.active === path ? (paths[at] ?? paths[at - 1]) : state.active;
  return {
    paths,
    ...(active !== undefined && { active }),
    ...(state.preview !== undefined && state.preview !== path && { preview: state.preview }),
  };
}

/** 关掉“预览标签页”时现有的预览标签就地固定。 */
export function pinAll(state: OpenFiles): OpenFiles {
  return state.preview === undefined ? state : pinPath(state, state.preview);
}

/** 文件树放在哪一侧：自动时放在靠窗口边缘的一侧（窗格在窗口右半边就放右边）。 */
export type TreePosition = 'auto' | 'left' | 'right';

export function treeSide(
  position: TreePosition,
  pane: { left: number; width: number } | undefined,
  windowWidth: number,
): 'left' | 'right' {
  if (position !== 'auto') return position;
  if (!pane || windowWidth <= 0) return 'right';
  return pane.left + pane.width / 2 >= windowWidth / 2 ? 'right' : 'left';
}
