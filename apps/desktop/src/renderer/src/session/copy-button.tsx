import { CopyGlyph, useCopied } from '@/components/copy-glyph';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';

/** 复制一段文字（U36，消息的“复制”）：点了之后 1.5 s 内显示对勾，复制图标与对勾之间有过渡（components/copy-glyph.tsx）。 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, markCopied] = useCopied();
  return (
    <IconButton
      label={copied ? t('message.copied') : t('message.copy')}
      size="icon-xs"
      className={className}
      onClick={() => void platformApi().copyText(text).then(markCopied)}
      data-action="copy-message"
    >
      <CopyGlyph copied={copied} />
    </IconButton>
  );
}
