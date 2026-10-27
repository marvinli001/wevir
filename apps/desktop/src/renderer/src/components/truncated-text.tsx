import { cn } from 'cn';
import { useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** 单行截断的文字；被截断时悬停显示全文，没截断时不出提示。 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const element = ref.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
    >
      <TooltipTrigger render={<span ref={ref} className={cn('truncate', className)} />}>
        {text}
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
