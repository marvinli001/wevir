import type { UserImagePart } from '@wevir/protocol';
import { cn } from 'cn';
import { useState } from 'react';
import { t } from '@/i18n';
import { ImagePreview, useImageData } from './image-attachments';

// 工具读到的图片（看图、读图片文件、截图类工具的 `tool.finished.images`），照 Claude Code：收起的组头与逐条的一行在行尾
// 带一张小缩略图，展开的那条列出图片，点开看大图。生成图片的工具不走这里（generated-image.tsx）。

/** 行尾的小缩略图：只是提示，点的是整行。读不到时不画。 */
export function ToolThumb({ image, className }: { image: UserImagePart; className?: string }) {
  const { src } = useImageData(image);
  if (src === undefined) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      data-tool-thumb={image.imageId}
      className={cn(
        'h-6 w-9 shrink-0 rounded-md border border-border bg-muted object-cover',
        className,
      )}
    />
  );
}

/** 展开后的图片：按比例显示，最高 320 px，点开看大图。 */
export function ToolImageList({ images }: { images: readonly UserImagePart[] }) {
  return (
    <div className="flex flex-col items-start gap-2" data-tool-images>
      {images.map((image) => (
        <ToolImage key={image.imageId} image={image} />
      ))}
    </div>
  );
}

const MAX_WIDTH = 480;
const MAX_HEIGHT = 320;

function ToolImage({ image }: { image: UserImagePart }) {
  const { src, failed } = useImageData(image);
  const [open, setOpen] = useState(false);
  if (failed) return <p className="text-xs text-muted-foreground">{t('image.unavailable')}</p>;
  // 宽度取原宽、480 px 与高 320 px 时的宽里最小的，按比例定高，读回来之前占好位置。
  const size =
    image.width !== undefined && image.height !== undefined && image.height > 0
      ? {
          aspectRatio: `${image.width} / ${image.height}`,
          width: Math.min(image.width, MAX_WIDTH, (MAX_HEIGHT * image.width) / image.height),
        }
      : undefined;
  return (
    <>
      <button
        type="button"
        disabled={src === undefined}
        onClick={() => setOpen(true)}
        aria-label={t('image.preview')}
        data-image-id={image.imageId}
        style={size}
        className="block max-h-80 max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:focus-field disabled:cursor-default"
      >
        {src && <img src={src} alt="" className="size-full max-h-80 object-contain" />}
      </button>
      <ImagePreview src={open ? src : undefined} onClose={() => setOpen(false)} />
    </>
  );
}
