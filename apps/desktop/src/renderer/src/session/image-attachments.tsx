// 消息里的图片（0.28.0）：上传、按引用读回、输入框上方的缩略图与消息里的图片、点开的大图。规则在 composer-images.ts。
// 图片一律用 data URL 显示（CSP 的 img-src 只放行 'self' 与 data:）。

import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import type { ImageId, UserImageMimeType, UserImagePart } from '@wevir/protocol';
import { cn } from 'cn';
import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { base64Of, modelAcceptsImages } from './composer-images';

/** 读回来的图片（data URL），按 ID 缓存；最多留这么多张，先进先出。 */
const CACHE_LIMIT = 40;
const cache = new Map<ImageId, Promise<string>>();

function remember(imageId: ImageId, data: Promise<string>): Promise<string> {
  cache.delete(imageId);
  cache.set(imageId, data);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // 读失败的不留着，下次再读。
  data.catch(() => {
    if (cache.get(imageId) === data) cache.delete(imageId);
  });
  return data;
}

/** 能不能给这个模型发图片：Host 有 `user_images`，模型列表没说它不收（`modelAcceptsImages`）。 */
export function useAcceptsImages(
  choice: { providerId: string; modelId: string } | undefined,
): boolean {
  const { view } = useHostConnection();
  const data = useWorkbenchData();
  if (choice === undefined || view.status !== 'connected') return false;
  if (!hostSupports(view.hello.features, 'user_images')) return false;
  const provider =
    data.status === 'ready'
      ? data.providers.find((candidate) => candidate.id === choice.providerId)
      : undefined;
  return modelAcceptsImages(provider, choice.modelId);
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('cannot read the image'));
    reader.readAsDataURL(file);
  });
}

/** 传给 Host（已读成 data URL）；发出去的消息里直接用本地的这份显示，不再读回来。 */
export async function uploadImage(
  client: WevirClient,
  dataUrl: string,
  mimeType: UserImageMimeType,
  name?: string,
): Promise<UserImagePart> {
  const { image } = await client.request('image.upload', {
    mimeType,
    data: base64Of(dataUrl),
    ...(name !== undefined && name !== '' && { name: name.slice(0, 255) }),
  });
  remember(image.imageId, Promise.resolve(`data:${image.mimeType};base64,${base64Of(dataUrl)}`));
  return image;
}

/** 按引用读回一张图片（`image.read`，大的分几段）。 */
export function readImage(client: WevirClient, part: UserImagePart): Promise<string> {
  const cached = cache.get(part.imageId);
  if (cached) return cached;
  const load = async () => {
    const first = await client.request('image.read', { imageId: part.imageId });
    let binary = atob(first.data);
    if (binary.length >= first.size) return `data:${first.mimeType};base64,${first.data}`;
    // 大的图片分几段读；每段是独立的 base64，先解开再合起来。
    while (binary.length < first.size) {
      const next = await client.request('image.read', {
        imageId: part.imageId,
        offset: binary.length,
      });
      const chunk = atob(next.data);
      if (chunk.length === 0) break;
      binary += chunk;
    }
    return `data:${first.mimeType};base64,${btoa(binary)}`;
  };
  return remember(part.imageId, load());
}

/** 一张消息里的图片：读回来之前是 undefined。 */
function useImageData(part: UserImagePart): { src?: string; failed: boolean } {
  const { client } = useHostConnection();
  const [state, setState] = useState<{ src?: string; failed: boolean }>({ failed: false });
  useEffect(() => {
    if (!client) return;
    let live = true;
    setState({ failed: false });
    readImage(client, part).then(
      (src) => live && setState({ src, failed: false }),
      () => live && setState({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [client, part]);
  return state;
}

/** 点开的大图。 */
export function ImagePreview({
  src,
  name,
  onClose,
}: {
  src: string | undefined;
  name?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={src !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-auto max-w-[min(90vw,1200px)] p-2 sm:max-w-[min(90vw,1200px)]"
        data-testid="image-preview"
      >
        <DialogTitle className="sr-only">{name ?? t('image.preview')}</DialogTitle>
        {src && (
          <img
            src={src}
            alt={name ?? t('image.preview')}
            className="max-h-[85vh] max-w-full rounded-lg object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 输入框上方的一张缩略图：传完之前转圈，右上角移除。 */
export function ComposerThumb({
  src,
  name,
  uploading,
  onRemove,
  onOpen,
}: {
  src: string;
  name?: string;
  uploading: boolean;
  onRemove: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="group/thumb relative size-14 shrink-0" data-testid="composer-image">
      <button
        type="button"
        onClick={onOpen}
        aria-label={name ?? t('image.preview')}
        className="size-full overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:focus-field"
      >
        <img src={src} alt="" className={cn('size-full object-cover', uploading && 'opacity-50')} />
      </button>
      {uploading && (
        <LoaderCircle
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto size-4 animate-spin text-foreground"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('composer.removeImage')}
        data-action="remove-image"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-xs outline-none transition-opacity duration-150 group-hover/thumb:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:focus-field"
      >
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}

/** 消息里的图片：一行缩略图，按像素比例占位，点开看大图。 */
export function MessageImages({
  images,
  className,
}: {
  images: readonly UserImagePart[];
  className?: string | undefined;
}) {
  const [open, setOpen] = useState<{ src: string; name?: string }>();
  return (
    <div
      className={cn('flex max-w-[85%] flex-wrap justify-end gap-1.5', className)}
      data-testid="message-images"
    >
      {images.map((image) => (
        <MessageImage
          key={image.imageId}
          image={image}
          onOpen={(src) => setOpen({ src, ...(image.name !== undefined && { name: image.name }) })}
        />
      ))}
      <ImagePreview src={open?.src} name={open?.name} onClose={() => setOpen(undefined)} />
    </div>
  );
}

/** 缩略图的高度（px）；宽度按像素比例，最宽 240。 */
const THUMB_HEIGHT = 128;

function MessageImage({ image, onOpen }: { image: UserImagePart; onOpen: (src: string) => void }) {
  const { src, failed } = useImageData(image);
  const ratio =
    image.width !== undefined && image.height !== undefined ? image.width / image.height : 1;
  const width = Math.min(240, Math.max(48, Math.round(THUMB_HEIGHT * ratio)));
  return (
    <button
      type="button"
      disabled={src === undefined}
      onClick={() => src && onOpen(src)}
      aria-label={image.name ?? t('image.preview')}
      data-image-id={image.imageId}
      style={{ width, height: THUMB_HEIGHT }}
      className="overflow-hidden rounded-xl border border-border bg-muted outline-none focus-visible:focus-field"
    >
      {src ? (
        <img src={src} alt={image.name ?? ''} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-xs text-muted-foreground">
          {failed ? t('image.unavailable') : null}
        </span>
      )}
    </button>
  );
}
