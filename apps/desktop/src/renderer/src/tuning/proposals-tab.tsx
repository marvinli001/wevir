// 调优页的“建议”分段（0.87.0，desktop-layout.md §35）：待审 / 已处理两组，“从会话生成”选这个范围里的一个会话（全局时是全部项目的）
// 调一次模型。结果（几条、用了多少 token，或没生成的原因）显示在列表上方；列表随 `tuning.proposal.changed` 重读。

import type { WevirClient } from '@wevir/client-sdk';
import type { Session, SessionId, TuningProposal } from '@wevir/protocol';
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { EmptyList, LIST_CARD, type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { ProposalCard } from './proposals-card';
import { generatedText, reasonText } from './proposals-model';
import { useProposals } from './use-proposals';

/** “从会话生成”最多列几个会话（最近活动的在前）。 */
const SESSIONS_MAX = 30;

type View = 'open' | 'decided';

export function ProposalsTab({
  client,
  workspaceId,
}: {
  client: WevirClient;
  /** 省略是全局：列全部项目的建议。 */
  workspaceId: string | undefined;
}) {
  const [view, setView] = useState<View>('open');
  const data = useProposals(client, workspaceId, view);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const workbench = useWorkbenchData();
  const sessions = useMemo<Session[]>(() => {
    if (workbench.status !== 'ready') return [];
    return projectsOf(workbench.workspaces)
      .filter((entry) => workspaceId === undefined || entry.workspace.id === workspaceId)
      .flatMap((entry) => entry.sessions)
      .filter((session) => session.parentSessionId === undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, SESSIONS_MAX);
  }, [workbench, workspaceId]);

  const generate = async (sessionId: SessionId, replaces?: TuningProposal) => {
    setGenerating(true);
    setNotice(undefined);
    try {
      const result = await client.request('tuning.proposal.generate', {
        sessionId,
        ...(replaces !== undefined && { replaces: replaces.id }),
      });
      setNotice(
        result.reason !== undefined
          ? {
              tone: 'error',
              text: t('tuning.proposals.failed', { reason: reasonText(result.reason) }),
            }
          : {
              tone: result.proposals.length === 0 ? 'info' : 'success',
              text: generatedText(result),
            },
      );
      if (result.reason === undefined && result.proposals.length > 0) setView('open');
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('tuning.proposals.failed', { reason: describe(reason) }),
      });
    } finally {
      setGenerating(false);
    }
  };

  const open = data.open ?? 0;
  return (
    <div data-testid="tuning-proposals" data-view={view}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Segmented<View>
          label={t('tuning.tab.proposals')}
          value={view}
          onChange={setView}
          options={[
            {
              value: 'open',
              label:
                open > 0 ? `${t('tuning.proposals.open')} ${open}` : t('tuning.proposals.open'),
            },
            { value: 'decided', label: t('tuning.proposals.decided') },
          ]}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                disabled={generating}
                data-action="proposals-generate"
              >
                {generating ? t('tuning.proposals.generating') : t('tuning.proposals.generate')}
                <ChevronDown aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
            {sessions.length === 0 ? (
              <DropdownMenuItem disabled>{t('tuning.proposals.noSessions')}</DropdownMenuItem>
            ) : (
              sessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onClick={() => void generate(session.id as SessionId)}
                  data-session={session.id}
                >
                  <span className="truncate">{session.title || t('tuning.proposal.untitled')}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {notice !== undefined && (
        <div className="mb-3" data-testid="proposals-notice">
          <NoticeBanner notice={notice} />
        </div>
      )}
      {data.error !== undefined && (
        <div className="mb-3">
          <NoticeBanner notice={{ tone: 'error', text: describe(data.error) }} />
        </div>
      )}
      {data.proposals === undefined ? (
        data.error === undefined && (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )
      ) : data.proposals.length === 0 ? (
        <EmptyList>{t('tuning.proposals.none')}</EmptyList>
      ) : (
        <ul className={LIST_CARD} data-testid="proposals-list">
          {data.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              client={client}
              proposal={proposal}
              onRegenerate={(stale) => generate(stale.sessionId, stale)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
