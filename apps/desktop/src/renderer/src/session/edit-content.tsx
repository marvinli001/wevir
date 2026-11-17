import type { UserContentPart } from '@wevir/protocol';
import { type KeyboardEvent, type Ref, useId } from 'react';
import { t } from '@/i18n';
import { MessageImages } from './image-attachments';
import { MessageFiles } from './message-files';
import { MessagePastes } from './pasted-text';

export function EditContent({
  content,
  editor,
}: {
  content: readonly UserContentPart[];
  editor?: {
    first: Ref<HTMLTextAreaElement>;
    disabled: boolean;
    change(index: number, text: string): void;
    keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  };
}) {
  const id = useId();
  const first = content.findIndex((part) => part.type === 'text' && !part.pasted);
  return (
    <div className="grid min-w-0 gap-2">
      {content.map((part, index) => {
        // 部件保留原消息里的位置，编辑时只改变文本。
        const key = `${id}-${index}`;
        if (part.type === 'image') return <MessageImages key={key} images={[part]} />;
        if (part.type === 'file') return <MessageFiles key={key} files={[part]} />;
        if (part.pasted) return <MessagePastes key={key} texts={[part.text]} />;
        if (!editor)
          return (
            <p key={key} className="whitespace-pre-wrap break-words text-sm">
              {part.text}
            </p>
          );
        return (
          <textarea
            key={key}
            ref={index === first ? editor.first : undefined}
            value={part.text}
            rows={1}
            aria-label={t('message.editPart', { index: index + 1 })}
            disabled={editor.disabled}
            onChange={(event) => editor.change(index, event.target.value)}
            onKeyDown={editor.keyDown}
            className="field-sizing-content min-h-8 max-h-72 w-full resize-none rounded-md bg-transparent px-1.5 py-1 text-base outline-none focus-visible:focus-field"
          />
        );
      })}
    </div>
  );
}
