// 项目背景（视觉打磨，参照 MonoCode 的 Haze）：每个项目可以在内容卡片顶上铺一层背景，往输入框方向渐隐。只存在本机
// （localStorage，不经 Host）；预设是 index.css 的 backdrop-* 渐变，自定义图片缩成 JPEG 的 data URL 存下。

export const BACKDROP_PRESETS = ['dawn', 'mist', 'sage', 'dusk', 'ember'] as const;
export type BackdropPreset = (typeof BACKDROP_PRESETS)[number];

export type ProjectBackdrop =
  | { kind: 'preset'; preset: BackdropPreset }
  /** `src` 是 `data:image/jpeg;base64,…`（loadBackdropImage 缩过的），CSP 的 img-src 放行 data:。 */
  | { kind: 'image'; src: string };

/** 按项目（workspace ID）记的背景；没有的项目不铺。 */
export type ProjectBackdrops = Readonly<Record<string, ProjectBackdrop>>;

export const BACKDROP_STORAGE_KEY = 'wevir.project-backdrop.v1';

/** 一张图片存下来最多这么长（data URL 的字符数，约 1.5 MB）；localStorage 一共只有约 5 MB。 */
export const BACKDROP_IMAGE_MAX_CHARS = 2_000_000;

/** 自定义图片缩到这么宽（px），卡片顶上的背景用不着更大。 */
export const BACKDROP_IMAGE_MAX_WIDTH = 1600;

export function parseBackdrop(raw: unknown): ProjectBackdrop | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'preset' && (BACKDROP_PRESETS as readonly unknown[]).includes(value.preset)) {
    return { kind: 'preset', preset: value.preset as BackdropPreset };
  }
  if (
    value.kind === 'image' &&
    typeof value.src === 'string' &&
    value.src.startsWith('data:image/') &&
    value.src.length <= BACKDROP_IMAGE_MAX_CHARS
  ) {
    return { kind: 'image', src: value.src };
  }
  return undefined;
}

/** 读回存下的表：坏掉的项丢掉，其余照用。 */
export function parseBackdrops(raw: unknown): ProjectBackdrops {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, ProjectBackdrop> = {};
  for (const [id, value] of Object.entries(raw)) {
    const backdrop = parseBackdrop(value);
    if (backdrop) result[id] = backdrop;
  }
  return result;
}

/** 设上或去掉一个项目的背景（undefined 是不铺）。 */
export function withBackdrop(
  current: ProjectBackdrops,
  workspaceId: string,
  backdrop: ProjectBackdrop | undefined,
): ProjectBackdrops {
  const { [workspaceId]: _removed, ...rest } = current;
  return backdrop ? { ...rest, [workspaceId]: backdrop } : rest;
}

export function sameBackdrop(a: ProjectBackdrop | undefined, b: ProjectBackdrop | undefined) {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'preset' && b.kind === 'preset') return a.preset === b.preset;
  if (a.kind === 'image' && b.kind === 'image') return a.src === b.src;
  return false;
}
