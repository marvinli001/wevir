import { createPersistedStore } from '@/lib/store';
import {
  BACKDROP_IMAGE_MAX_CHARS,
  BACKDROP_IMAGE_MAX_WIDTH,
  BACKDROP_STORAGE_KEY,
  type ProjectBackdrop,
  type ProjectBackdrops,
  parseBackdrops,
  withBackdrop,
} from './backdrop-model';

/** 各项目的背景（backdrop-model.ts），只存在本机。 */
export const projectBackdrops = createPersistedStore<ProjectBackdrops>(
  BACKDROP_STORAGE_KEY,
  {},
  parseBackdrops,
);

export function useProjectBackdrop(workspaceId: string | undefined): ProjectBackdrop | undefined {
  const all = projectBackdrops.use();
  return workspaceId === undefined ? undefined : all[workspaceId];
}

export function setProjectBackdrop(workspaceId: string, backdrop: ProjectBackdrop | undefined) {
  projectBackdrops.set((current) => withBackdrop(current, workspaceId, backdrop));
}

/** 把选的图片缩到最宽 BACKDROP_IMAGE_MAX_WIDTH、转成 JPEG 的 data URL；读不出来或缩完还太大时抛错。 */
export async function loadBackdropImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, BACKDROP_IMAGE_MAX_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const src = canvas.toDataURL('image/jpeg', 0.82);
    if (src.length > BACKDROP_IMAGE_MAX_CHARS) throw new Error('image too large');
    return src;
  } finally {
    bitmap.close();
  }
}

/**
 * 内容卡片顶上的项目背景：盖住卡片上半部分，往下（输入框方向）渐隐，不接鼠标，画在卡片内容的下面（卡片里排在内容之前、
 * 同是定位元素）。样式在 index.css 的 project-backdrop。
 */
export function ProjectBackdropLayer({ workspaceId }: { workspaceId: string | undefined }) {
  const backdrop = useProjectBackdrop(workspaceId);
  if (!backdrop) return null;
  return (
    <div
      aria-hidden
      className="project-backdrop"
      data-backdrop={backdrop.kind === 'preset' ? backdrop.preset : undefined}
    >
      {backdrop.kind === 'image' && <img src={backdrop.src} alt="" draggable={false} />}
    </div>
  );
}
