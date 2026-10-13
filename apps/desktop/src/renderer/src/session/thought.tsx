import type { ChatPartOf } from '@wevir/client-sdk';
import { memo } from 'react';
import { t } from '@/i18n';
import { Disclosure } from './disclosure';

/** 思考过程：默认折叠，标题行显示字数；还在生成时显示“正在思考…”。 */
export const Thought = memo(function Thought({
  part,
  settled = false,
}: {
  part: ChatPartOf<'reasoning'>;
  /** 后面已经有别的输出：思考已结束，只是已提交的版本还没到。 */
  settled?: boolean;
}) {
  const streaming = part.state === 'streaming' && !settled;
  return (
    <Disclosure
      className="my-2"
      summaryClassName="py-0.5 text-sm text-muted-foreground hover:text-foreground"
      summary={
        <>
          <span className={streaming ? 'animate-pulse' : undefined}>
            {streaming ? t('thought.streaming') : t('thought.title')}
          </span>
          <span className="text-xs text-faint-foreground">
            {t('thought.length', { count: [...part.text].length })}
          </span>
        </>
      }
    >
      <p className="mt-1 ml-5 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {part.text}
      </p>
    </Disclosure>
  );
});
