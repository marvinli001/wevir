import type { ProviderProfile, SessionId } from '@wevir/protocol';
import { useMemo } from 'react';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { sourceOf } from '@/data/sources';
import { sameFields } from '@/data/transcript-selection';
import { useTranscriptSelector, useWorkbenchProviders } from '@/data/workbench-data';
import { t } from '@/i18n';
import { providerLogo } from '@/settings/provider-catalog';
import { focusTranscript } from './transcript-focus';
import { engineSources } from './turn-model';

const NO_PROVIDERS: readonly ProviderProfile[] = [];

export function EngineTrail({ sessionId }: { sessionId: SessionId }) {
  const state = useTranscriptSelector(
    sessionId,
    (state) => ({
      segments: state?.transcript.engineSegments,
      firstSeq: state?.transcript.messages[0]?.seqRange[0],
    }),
    sameFields,
  );
  const providers = useWorkbenchProviders() ?? NO_PROVIDERS;
  const segments = state.segments;
  const sources = useMemo(() => engineSources(segments ?? [], providers), [segments, providers]);
  if (sources.length === 0) return null;
  return (
    <nav
      aria-label={t('session.engineTrail')}
      className="flex max-w-[40%] shrink-0 items-center self-center overflow-x-auto"
      data-testid="engine-trail"
    >
      {sources.map((segment) => {
        const provider = providers.find((candidate) => candidate.id === segment.providerId);
        const source = provider && sourceOf(provider);
        const name = source ? t(source.name) : (provider?.displayName ?? segment.providerId);
        return (
          <IconButton
            key={segment.seq}
            label={name}
            size="icon-xs"
            className="shrink-0"
            data-engine-seq={segment.seq}
            onClick={() =>
              focusTranscript({
                sessionId,
                seq: segment.segment === 0 ? (state.firstSeq ?? segment.seq) : segment.seq,
              })
            }
          >
            <ProviderLogo
              logo={source?.logo ?? (provider && providerLogo(provider))}
              fallback={name}
              className="size-3.5"
            />
          </IconButton>
        );
      })}
    </nav>
  );
}
