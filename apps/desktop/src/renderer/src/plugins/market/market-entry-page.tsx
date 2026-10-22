// 市场条目的详情页（plugin-market.md §9.2，`/plugins/market/:source/:entry`）：头部（图标、名称与徽章、发布者、“···”与主按钮）、
// 示例、README、MCP 服务器与技能列表、信息表。主按钮是 install-button.tsx（0.99.0 起能装）；示例还只看不点。

import type { MarketEntry, MarketMirror } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CloudOff, Ellipsis, ExternalLink, Link2, Server } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { commandLine } from '../plugins-model';
import { MarketInstallButton } from './install-button';
import {
  decodeText,
  entryPublisher,
  entryReadmePath,
  entryText,
  entryWebUrl,
  KIND_LABEL,
  localizedName,
  OFFICIAL_SOURCE,
  upstreamLabel,
} from './market-model';
import { EntryIcon } from './market-rows';
import { BackButton } from './market-tab';
import { type MarketData, type MarketSource, useMarketFile } from './use-market';
import { VerificationBadge } from './verification-badge';

export function MarketEntryPage({
  data,
  source,
  sourceId,
  entryId,
  onCopied,
}: {
  data: MarketData;
  source: MarketSource | undefined;
  sourceId: string;
  entryId: string;
  /** 复制链接之后（页面上方的通知）。 */
  onCopied: () => void;
}) {
  const { state } = data;
  const entry =
    state.status === 'ready' && sourceId === OFFICIAL_SOURCE
      ? state.result.index.entries.find((item) => item.id === entryId)
      : undefined;
  return (
    <div className="mx-auto w-full max-w-180" data-testid="market-entry" data-entry={entryId}>
      <div className="mb-4">
        <BackButton label={t('plugins.title')} fallback={paths.plugins('market')} />
      </div>
      {state.status === 'loading' && (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}
      {state.status === 'error' && (
        <EmptyState
          icon={<CloudOff />}
          title={t('plugins.market.loadFailed')}
          action={
            <Button variant="outline" onClick={data.refresh}>
              {t('plugins.market.retry')}
            </Button>
          }
        >
          <span className="text-sm">{state.error}</span>
        </EmptyState>
      )}
      {state.status === 'ready' && entry === undefined && (
        <EmptyState icon={<CloudOff />} title={t('plugins.market.entryMissing')} />
      )}
      {state.status === 'ready' && entry !== undefined && (
        <EntryDetail
          entry={entry}
          source={source}
          commit={state.result.index.commit}
          mirror={state.result.mirror}
          categories={state.result.index.categories}
          onCopied={onCopied}
        />
      )}
    </div>
  );
}

function EntryDetail({
  entry,
  source,
  commit,
  mirror,
  categories,
  onCopied,
}: {
  entry: MarketEntry;
  source: MarketSource | undefined;
  commit: string;
  mirror: MarketMirror;
  categories: readonly { id: string; name: Readonly<Record<string, string>> }[];
  onCopied: () => void;
}) {
  const locale = currentLocale();
  const text = entryText(entry, locale);
  const publisher = entryPublisher(entry);
  const { connectors, skills } = entry.contents;
  const category = categories.find((item) => item.id === entry.category);
  return (
    <>
      <header className="mb-8 flex items-start gap-4">
        <EntryIcon entry={entry} source={source} commit={commit} size="lg" />
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{text.name}</h1>
            {entry.verification && (
              <VerificationBadge
                verification={entry.verification}
                upstream={entry.upstream}
                size="lg"
              />
            )}
          </div>
          {publisher && (
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {t('plugins.market.by', { publisher })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton label={t('plugins.market.more')} variant="outline" size="icon">
                  <Ellipsis />
                </IconButton>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() =>
                  void window.wevir.copyText(entryWebUrl(mirror, entry)).then(onCopied)
                }
              >
                <Link2 />
                {t('plugins.market.copyLink')}
              </DropdownMenuItem>
              {entry.upstream && (
                <DropdownMenuItem
                  onClick={() => void window.wevir.openExternal(entry.upstream?.url ?? '')}
                >
                  <ExternalLink />
                  {t('plugins.market.viewUpstream')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <MarketInstallButton entry={entry} variant="detail" />
        </div>
      </header>

      {text.examples.length > 0 && (
        <section
          className="mb-8 space-y-2 rounded-xl bg-linear-to-br from-muted via-muted/40 to-background p-4 ring-1 ring-border ring-inset"
          aria-label={t('plugins.market.examples')}
          data-testid="market-examples"
        >
          {text.examples.slice(0, 3).map((example) => (
            <div
              key={example}
              className="flex items-start gap-3 rounded-lg bg-card px-3.5 py-3 text-sm shadow-xs ring-1 ring-border ring-inset"
            >
              <span className="flex shrink-0 items-center gap-1.5 pt-px">
                <EntryIcon entry={entry} source={source} commit={commit} size="xs" />
                <span className="text-xs font-medium text-muted-foreground">{text.name}</span>
              </span>
              <span className="min-w-0 flex-1 break-words">{example}</span>
            </div>
          ))}
        </section>
      )}

      <DetailBlock title={t('plugins.market.about')}>
        <Readme entry={entry} source={source} commit={commit} fallback={text.description} />
      </DetailBlock>

      {connectors.length > 0 && (
        <DetailBlock title={t('plugins.market.servers', { count: connectors.length })}>
          <ConnectorRows connectors={connectors} />
        </DetailBlock>
      )}

      {skills.length > 0 && (
        <DetailBlock title={t('plugins.market.skills', { count: skills.length })}>
          <ul className="divide-y divide-border rounded-xl ring-1 ring-border ring-inset">
            {skills.map((skill) => (
              <li key={skill.name} className="px-4 py-3">
                <div className="text-sm font-medium">{skill.name}</div>
                {skill.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {skill.description.replace(/\s+/g, ' ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DetailBlock>
      )}

      <DetailBlock title={t('plugins.market.info')}>
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm">
          {entry.author && (
            <InfoRow label={t('plugins.market.info.developer')}>
              {entry.author.url ? (
                <ExternalLinkText url={entry.author.url}>{entry.author.name}</ExternalLinkText>
              ) : (
                entry.author.name
              )}
            </InfoRow>
          )}
          <InfoRow label={t('plugins.market.info.category')}>
            {category ? localizedName(category.name, locale, category.id) : entry.category}
          </InfoRow>
          <InfoRow label={t('plugins.market.info.kind')}>{t(KIND_LABEL[entry.kind])}</InfoRow>
          <InfoRow label={t('plugins.market.info.version')}>
            {entry.upstream?.version
              ? t('plugins.market.info.versionUpstream', {
                  version: entry.version,
                  upstream: entry.upstream.version,
                })
              : entry.version}
          </InfoRow>
          {entry.upstream && (
            <InfoRow label={t('plugins.market.info.upstream')}>
              <ExternalLinkText url={entry.upstream.url}>
                {upstreamLabel(entry.upstream.url)}
              </ExternalLinkText>
            </InfoRow>
          )}
          {(entry.license ?? entry.upstream?.license) && (
            <InfoRow label={t('plugins.market.info.license')}>
              {entry.license ?? entry.upstream?.license}
            </InfoRow>
          )}
          {entry.requires?.runtimes && entry.requires.runtimes.length > 0 && (
            <InfoRow label={t('plugins.market.info.requires')}>
              <span className="font-mono text-xs">{entry.requires.runtimes.join(', ')}</span>
            </InfoRow>
          )}
          {entry.homepage && (
            <InfoRow label={t('plugins.market.info.website')}>
              <ExternalLinkText url={entry.homepage}>{hostOf(entry.homepage)}</ExternalLinkText>
            </InfoRow>
          )}
          {entry.links?.privacy && (
            <InfoRow label={t('plugins.market.info.privacy')}>
              <ExternalLinkText url={entry.links.privacy}>
                {hostOf(entry.links.privacy)}
              </ExternalLinkText>
            </InfoRow>
          )}
          {entry.links?.terms && (
            <InfoRow label={t('plugins.market.info.terms')}>
              <ExternalLinkText url={entry.links.terms}>
                {hostOf(entry.links.terms)}
              </ExternalLinkText>
            </InfoRow>
          )}
        </dl>
      </DetailBlock>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** 外链：系统浏览器打开，后面一个外链图标。 */
function ExternalLinkText({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void window.wevir.openExternal(url)}
      className="inline-flex max-w-full items-center gap-1 rounded-sm text-left underline decoration-border underline-offset-2 outline-none transition-colors duration-150 hover:decoration-foreground focus-visible:focus-ring"
    >
      <span className="min-w-0 truncate">{children}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** README（按索引的提交从当前镜像读）；没有、读不到或 Host 读不了文件时用描述。 */
function Readme({
  entry,
  source,
  commit,
  fallback,
}: {
  entry: MarketEntry;
  source: MarketSource | undefined;
  commit: string;
  fallback: string;
}) {
  const file = useMarketFile(source, commit, entry.id, entryReadmePath(entry));
  if (file.status === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  if (file.status === 'ready') {
    return (
      <div className="text-sm" data-testid="market-readme">
        <MarkdownView text={decodeText(file.data)} streaming={false} />
      </div>
    );
  }
  return fallback === '' ? null : <p className="text-sm text-soft-foreground">{fallback}</p>;
}

/** 连接器：每行图标与名称，展开显示将执行的命令与参数，或会连接的地址（§10）。 */
function ConnectorRows({ connectors }: { connectors: MarketEntry['contents']['connectors'] }) {
  const [open, setOpen] = useState<string>();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-border ring-inset">
      {connectors.map((connector) => {
        const expanded = open === connector.name;
        const detail =
          connector.transport === 'stdio'
            ? commandLine(connector.command ?? '', connector.args)
            : (connector.url ?? '');
        return (
          <li key={connector.name} data-market-connector={connector.name}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? undefined : connector.name)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset"
            >
              <Server aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{connector.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(
                  connector.transport === 'stdio'
                    ? 'plugins.connector.transport.stdio'
                    : 'plugins.connector.transport.http',
                )}
              </span>
              <ChevronRight
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-smooth',
                  expanded && 'rotate-90',
                )}
              />
            </button>
            <Collapse open={expanded}>
              <div className="border-t border-border bg-background/40 px-4 py-3">
                <div className="rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap">
                  {detail}
                </div>
              </div>
            </Collapse>
          </li>
        );
      })}
    </ul>
  );
}
