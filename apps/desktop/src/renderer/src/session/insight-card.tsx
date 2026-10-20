// 输入框上方的“旁观提示”卡片（你应该知道，0.78.0，desktop-tokens §66）：Host 的后台检查提出的一件用户大概没注意到、但有后果的事。
// 收起时是口吻与一句话；展开后是标题与 Markdown 说明。“已知”之后的检查不再提这个话题，“忽略”只关掉这一条。

import type { SessionId, SessionInsight } from '@wevir/protocol';
import { CircleAlert, Lightbulb, X } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { MarkdownView } from './markdown/markdown-view';

export function InsightCard({
  sessionId,
  insight,
}: {
  sessionId: SessionId;
  insight: SessionInsight;
}) {
  const { client } = useHostConnection();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const respond = async (response: 'known' | 'dismissed') => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      // 卡片随 `insight.updated` 消失，不在这里先藏起来：失败时还能再点。
      await client.request('session.respondInsight', {
        sessionId,
        insightId: insight.id,
        response,
      });
    } catch (reason) {
      setError(t('insight.respondFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const Icon = insight.tag === 'heads_up' ? CircleAlert : Lightbulb;
  return (
    <section
      aria-label={t('insight.title')}
      data-testid="session-insight"
      data-insight-tag={insight.tag}
      className="mb-2 rounded-xl border border-border bg-background py-2 pr-1.5 pl-3 text-sm animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-muted-foreground text-xs">
            {t(insight.tag === 'heads_up' ? 'insight.tag.heads_up' : 'insight.tag.should_know')}
          </p>
          {expanded ? (
            <div className="mt-1 min-w-0">
              <p className="font-medium text-foreground">{insight.title}</p>
              <div className="mt-1 min-w-0">
                <MarkdownView text={insight.detail} streaming={false} />
              </div>
            </div>
          ) : (
            <p className="mt-0.5 break-words text-foreground">{insight.summary}</p>
          )}
        </div>
        <IconButton
          label={t('insight.dismiss')}
          size="icon-xs"
          disabled={busy || !client}
          onClick={() => void respond('dismissed')}
        >
          <X />
        </IconButton>
      </div>
      <div className="mt-1.5 flex items-center gap-1 pl-5.5">
        {error !== undefined && (
          <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
            {error}
          </p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? 'message.collapse' : 'message.expand')}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || !client}
            onClick={() => void respond('known')}
          >
            {t('insight.known')}
          </Button>
        </div>
      </div>
    </section>
  );
}
