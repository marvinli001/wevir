import { cn } from 'cn';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { FilePreviewBlock } from './file-preview';
import { filePreviews } from './file-preview-model';
import { formatJson } from './format';
import type { ToolPart } from './tool-model';

// 工具调用的详情（T5.3 的工具卡片展开后的内容，U2 起在工作组里逐条展开时显示）：参数与完整结果；修改与写文件（§56）是
// 按文件的预览。

/** 一次工具调用的参数与结果。`root` 是会话的工作目录（改动的文件路径相对它显示）。 */
export function ToolDetails({ part, root }: { part: ToolPart; root?: string }) {
  const previews = filePreviews(part);
  if (previews) {
    // 修改与写文件：按文件显示改动；成功时结果只是“已修改”一类的确认，不再列出。
    return (
      <div className="space-y-2">
        {previews.map((preview, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同一次改动里的文件列表不变。
          <FilePreviewBlock key={index} preview={preview} root={root} />
        ))}
        {part.status !== 'completed' && part.output && <Pre>{part.output.text}</Pre>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Section label={t('tool.input')}>
        <ToolInput part={part} />
      </Section>
      <Section label={t('tool.output')}>
        {part.output ? (
          <>
            <Pre>{part.output.text || t('tool.noOutput')}</Pre>
            {part.output.truncated && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('tool.outputTruncated', {
                  length: part.output.originalLength ?? part.output.text.length,
                })}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('tool.noOutput')}</p>
        )}
      </Section>
    </div>
  );
}

function ToolInput({ part }: { part: ToolPart }) {
  const { text, truncatedFrom } = formatJson(part.input ?? {});
  return (
    <>
      <Pre>{text}</Pre>
      {truncatedFrom !== undefined && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('tool.inputTruncated', { length: truncatedFrom })}
        </p>
      )}
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-words',
        className,
      )}
    >
      {children}
    </pre>
  );
}
