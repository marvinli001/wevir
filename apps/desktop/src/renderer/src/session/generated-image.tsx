import type { UserImagePart } from '@wevir/protocol';
import { useState } from 'react';
import { ImageReveal, revealWidth } from '@/fx/image-reveal';
import { t } from '@/i18n';
import { ImagePreview, useImageData } from './image-attachments';
import { type ToolPart, toolLifecycle } from './tool-model';

/** 结束多久以内的生成还放显现动画（刚生成完就切过来看的）；更早的直接显示。 */
const FRESH_MS = 15_000;

/**
 * Agent 生成的图片（0.116.0，展示类型 `image` 的工具）：在消息流里单独一块，不进工作组。生成中是 img-fx 的着色器，图片到了
 * 在同一个实例上显现（第一张与等待时是同一个元素）；点开看大图。打开会话时早就生成好的直接显示。失败、被停止时一行说明。
 */
export function GeneratedImage({ part, turnActive }: { part: ToolPart; turnActive: boolean }) {
  const lifecycle = toolLifecycle(part, turnActive);
  const pending = lifecycle === 'running' || lifecycle === 'awaiting_approval';
  // 挂载时还在生成，或刚生成完：放动画。
  const [animate] = useState(
    () =>
      pending ||
      (part.finishedAt !== undefined && Date.now() - Date.parse(part.finishedAt) < FRESH_MS),
  );
  const images = part.images ?? [];

  if (!pending && images.length === 0) {
    const text = part.output?.text.trim();
    return (
      <p className="my-2 text-sm text-muted-foreground" data-generated-image="failed">
        {lifecycle === 'cancelled' ? t('image.generateStopped') : t('image.generateFailed')}
        {text ? <span className="ml-1.5 text-muted-foreground/80">{text}</span> : null}
      </p>
    );
  }
  const slots: (UserImagePart | undefined)[] = pending ? [undefined] : [...images];
  const alt = part.display.summary ?? t('image.generated');
  return (
    <div className="my-3 flex flex-col gap-2" data-generated-image={pending ? 'pending' : 'done'}>
      {slots.map((image, index) => (
        // 按位置作 key：等待时的那一块就是第一张图，着色器接着显现，不重新开始。
        // biome-ignore lint/suspicious/noArrayIndexKey: 位置就是身份，图片只会整组到来
        <GeneratedImageView key={index} image={image} alt={alt} animate={animate} />
      ))}
      {pending && <p className="shimmer text-sm text-muted-foreground">{t('image.generating')}</p>}
    </div>
  );
}

function GeneratedImageView({
  image,
  alt,
  animate,
}: {
  /** 还在生成时没有。 */
  image: UserImagePart | undefined;
  alt: string;
  animate: boolean;
}) {
  const { src, failed } = useImageData(image);
  const [open, setOpen] = useState(false);
  const size =
    image?.width !== undefined && image.height !== undefined
      ? { width: image.width, height: image.height }
      : undefined;
  if (failed) {
    return <p className="text-sm text-muted-foreground">{t('image.unavailable')}</p>;
  }
  return (
    <>
      <button
        type="button"
        disabled={src === undefined}
        onClick={() => setOpen(true)}
        aria-label={t('image.preview')}
        title={image === undefined ? undefined : alt}
        {...(image !== undefined && { 'data-image-id': image.imageId })}
        style={{ width: revealWidth(size) }}
        className="block max-w-full cursor-zoom-in rounded-lg outline-none focus-visible:focus-field disabled:cursor-default"
      >
        <ImageReveal
          src={src}
          alt={image === undefined ? t('image.generating') : alt}
          size={size}
          revealKey={src === undefined ? undefined : image?.imageId}
          animate={animate}
        />
      </button>
      <ImagePreview src={open ? src : undefined} name={alt} onClose={() => setOpen(false)} />
    </>
  );
}
