import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';

/** 复制一段文字（U36，消息的“复制”）：点了之后 1.5 s 内显示对勾。 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      label={copied ? t('message.copied') : t('message.copy')}
      size="icon-xs"
      className={className}
      onClick={() =>
        void platformApi()
          .copyText(text)
          .then(() => setCopied(true))
      }
      data-action="copy-message"
    >
      {copied ? <Check className="confirm-pop" /> : <Copy />}
    </IconButton>
  );
}
