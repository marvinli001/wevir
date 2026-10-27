import { cn } from 'cn';
import { Hint } from './hint';

/** 单行截断的文字；被截断时悬停显示全文，没截断时不出提示。 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  return (
    <Hint label={text} whenClipped>
      <span className={cn('truncate', className)}>{text}</span>
    </Hint>
  );
}
