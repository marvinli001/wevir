import { cn } from 'cn';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { formatJson } from './format';
import { relativeToRoot, type ToolPart } from './tool-model';

// 工具调用的详情（T5.3 的工具卡片展开后的内容，U2 起在工作组里逐条展开时显示）：参数（编辑类显示新旧文本、写文件显示
// 内容）与完整结果。

/** 一次工具调用的参数与结果。`root` 是会话的工作目录（改动的文件路径相对它显示）。 */
export function ToolDetails({ part, root }: { part: ToolPart; root?: string }) {
  const changes = patchChanges(part);
  if (changes) {
    // Codex 的文件改动：按文件显示改动；成功时结果就是同一份 diff，不再重复。
    return (
      <div className="space-y-2">
        {changes.map((change, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同一次改动里的文件列表不变。
          <PatchView key={index} change={change} root={root} />
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
  const input = isRecord(part.input) ? part.input : undefined;
  if (part.display.kind === 'edit' && input) {
    const before = input.old_string;
    const after = input.new_string;
    if (typeof before === 'string' && typeof after === 'string') {
      return (
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 py-1.5 font-mono text-xs">
          {before.split('\n').map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态的行列表。
            <DiffLine key={`-${index}`} sign="-" line={line} />
          ))}
          {after.split('\n').map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态的行列表。
            <DiffLine key={`+${index}`} sign="+" line={line} />
          ))}
        </pre>
      );
    }
  }
  if (part.display.kind === 'write' && input && typeof input.content === 'string') {
    const { content, ...rest } = input;
    return (
      <>
        <Pre>{formatJson(rest).text}</Pre>
        <Pre className="mt-1.5">{content}</Pre>
      </>
    );
  }
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

function DiffLine({ sign, line }: { sign: '-' | '+'; line: string }) {
  return (
    <span
      className={cn(
        'block px-2 whitespace-pre-wrap',
        sign === '-' ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success',
      )}
    >
      {sign} {line}
    </span>
  );
}

interface PatchChange {
  path: string;
  kind: string;
  diff: string;
}

/** Codex `fileChange` 的输入（`changes[]`：新建与删除是文件全文，修改是统一 diff；tool-model.ts 的 editStats）。 */
function patchChanges(part: ToolPart): PatchChange[] | undefined {
  if (part.display.kind !== 'edit' && part.display.kind !== 'write') return undefined;
  const input = part.input;
  if (!isRecord(input) || !Array.isArray(input.changes)) return undefined;
  return input.changes.flatMap((change: unknown) =>
    isRecord(change) &&
    typeof change.path === 'string' &&
    typeof change.diff === 'string' &&
    isRecord(change.kind) &&
    typeof change.kind.type === 'string'
      ? [{ path: change.path, kind: change.kind.type, diff: change.diff }]
      : [],
  );
}

function PatchView({ change, root }: { change: PatchChange; root: string | undefined }) {
  const lines = change.diff.replace(/\n+$/, '').split('\n');
  return (
    <section>
      <h4 className="mb-1 truncate font-mono text-xs text-muted-foreground">
        {relativeToRoot(change.path, root)}
      </h4>
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 py-1.5 font-mono text-xs">
        {lines.map((line, index) => {
          const key = `${index}`;
          if (change.kind === 'add') return <DiffLine key={key} sign="+" line={line} />;
          if (change.kind === 'delete') return <DiffLine key={key} sign="-" line={line} />;
          if (line.startsWith('+') && !line.startsWith('+++ ')) {
            return <DiffLine key={key} sign="+" line={line.slice(1)} />;
          }
          if (line.startsWith('-') && !line.startsWith('--- ')) {
            return <DiffLine key={key} sign="-" line={line.slice(1)} />;
          }
          return (
            <span key={key} className="block px-2 whitespace-pre-wrap text-muted-foreground">
              {line}
            </span>
          );
        })}
      </pre>
    </section>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
