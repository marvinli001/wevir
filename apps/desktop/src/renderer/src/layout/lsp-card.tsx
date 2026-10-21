// 会话侧栏的“语言服务器”卡片（0.71.0，Host 功能 `lsp_status`）：当前项目里检测到的每种语言与项目根用哪个语言服务器、能不能用；
// 点一行打开详情：位置、来源、版本、服务端声明的能力、最近一次诊断，重启、启动日志，以及没装或版本过旧时的安装方案（会运行的确切
// 命令；项目之外的方案要勾选确认）。安装、验证的进度跟着 `lsp.changed` 刷新。设置里打开后才显示（默认不显示）；只在项目里的普通会话里有，旧 Host 没有这张卡片。

import { hostSupports } from '@wevir/client-sdk';
import type {
  LspInstallPlan,
  LspServerStatus,
  MethodResult,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Copy, RotateCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { isChats } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { formatMessageTime } from '@/session/format';
import {
  defaultPlan,
  INSTALL_LABELS,
  installing,
  lspSummary,
  rootLabel,
  rowDetail,
  SCOPE_LABELS,
  SOURCE_LABELS,
  STATE_LABELS,
  STATE_TONES,
} from './lsp-model';
import { type RailContext, registerRailCard } from './session-rail';

type LspStatus = MethodResult<'lsp.status'>;
type Target = { workspaceId: WorkspaceId; sessionId: SessionId };

/** `lsp.status`：侧栏看得见时读，`lsp.changed` 来了（合并 300 ms）或会话状态变了重读。 */
function useLspStatus(target: Target, active: boolean, refreshKey: string) {
  const { client, view } = useHostConnection();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'lsp_status');
  const [status, setStatus] = useState<LspStatus>();
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  const { workspaceId, sessionId } = target;

  const load = useCallback(
    (refresh = false) => {
      if (!client) return Promise.resolve();
      const id = ++seq.current;
      return client
        .request('lsp.status', { workspaceId, sessionId, ...(refresh && { refresh }) })
        .then(
          (result) => {
            if (id !== seq.current) return;
            setStatus(result);
            setError(undefined);
          },
          (reason: unknown) => {
            if (id === seq.current) setError(describe(reason));
          },
        );
    },
    [client, workspaceId, sessionId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重读。
  useEffect(() => {
    if (!client || !supported || !active) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onLspChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [client, supported, active, load, refreshKey]);

  return { supported, status, error, load };
}

const serverKey = (server: Pick<LspServerStatus, 'serverId' | 'root'>) =>
  `${server.serverId}\0${server.root}`;

function useLspCard({ sessionId, session, entry, visible }: RailContext) {
  const { supported, status, error, load } = useLspStatus(
    { workspaceId: entry.workspace.id, sessionId },
    visible,
    session.state,
  );
  if (!supported || session.parentSessionId !== undefined || isChats(entry.workspace)) return null;
  const summary = status === undefined ? undefined : lspSummary(status.servers);
  return {
    ...(summary !== undefined &&
      summary.total > 0 && {
        summary: (
          <>
            <StatusDot tone={summary.tone} />
            <span className="tabular-nums">
              {summary.ready}/{summary.total}
            </span>
          </>
        ),
      }),
    details: (
      <LspDetails
        target={{ workspaceId: entry.workspace.id, sessionId }}
        status={status}
        error={error}
        reload={load}
      />
    ),
  };
}

function LspDetails({
  target,
  status,
  error,
  reload,
}: {
  target: Target;
  status: LspStatus | undefined;
  error: string | undefined;
  reload: (refresh?: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const selected = status?.servers.find((server) => serverKey(server) === open);
  const refresh = async () => {
    setRefreshing(true);
    await reload(true);
    setRefreshing(false);
  };
  return (
    <div data-testid="rail-lsp">
      {error && <p className="mb-2 text-xs text-destructive">{t('lsp.failed', { error })}</p>}
      {status === undefined ? (
        !error && <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : status.servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('lsp.none')}</p>
      ) : (
        <ul className="space-y-0.5">
          {status.servers.map((server) => (
            <ServerRow
              key={serverKey(server)}
              server={server}
              dir={status.dir}
              onOpen={() => setOpen(serverKey(server))}
            />
          ))}
        </ul>
      )}
      <div className="mt-2 flex h-6 items-center gap-2">
        {status?.truncated && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t('lsp.truncated')}
          </span>
        )}
        <span className="flex-1" />
        <IconButton
          label={t('lsp.refresh')}
          size="icon-xs"
          className="-mr-1"
          disabled={refreshing}
          onClick={() => void refresh()}
          data-testid="rail-lsp-refresh"
        >
          <RotateCw className={cn(refreshing && 'animate-spin')} />
        </IconButton>
      </div>
      {selected && status && (
        <ServerDialog
          target={target}
          server={selected}
          dir={status.dir}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

function ServerRow({
  server,
  dir,
  onOpen,
}: {
  server: LspServerStatus;
  dir: string;
  onOpen: () => void;
}) {
  const root = rootLabel(dir, server.root);
  const detail = rowDetail(server);
  const state = t(detail.state);
  const busy = installing(server);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={server.reason ? `${state} · ${server.reason}` : state}
        data-lsp-server={server.serverId}
        data-lsp-state={server.state}
        className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
      >
        <StatusDot
          tone={busy ? 'accent' : STATE_TONES[server.state]}
          pulse={busy || server.state === 'starting'}
          label={state}
        />
        <span className="min-w-0 flex-1 truncate">
          {server.language}
          {root !== '' && (
            <span className="ml-1.5 font-mono text-xs text-muted-foreground">{root}</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {busy && server.install
            ? t(INSTALL_LABELS[server.install.status])
            : (detail.version ?? state)}
        </span>
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function ServerDialog({
  target,
  server,
  dir,
  onClose,
}: {
  target: Target;
  server: LspServerStatus;
  dir: string;
  onClose: () => void;
}) {
  const { client } = useHostConnection();
  const [log, setLog] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const ref = { ...target, serverId: server.serverId, root: server.root };
  const locale = currentLocale();
  const time = (iso: string | undefined) =>
    iso === undefined ? undefined : formatMessageTime(iso, locale);

  const act = async (run: () => Promise<unknown>) => {
    if (!client) return;
    setPending(true);
    setError(undefined);
    try {
      await run();
    } catch (reason) {
      setError(t('lsp.failed', { error: describe(reason) }));
    } finally {
      setPending(false);
    }
  };
  const showLog = () =>
    act(async () => {
      if (!client) return;
      setLog((await client.request('lsp.log', ref)).log);
    });

  const root = rootLabel(dir, server.root);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="lsp-server-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusDot tone={STATE_TONES[server.state]} />
            {server.language}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {root === '' ? server.root : root}
          </DialogDescription>
        </DialogHeader>
        {log !== undefined ? (
          <pre
            className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words"
            data-testid="lsp-log"
          >
            {log === '' ? t('lsp.log.empty') : log}
          </pre>
        ) : (
          <div className="max-h-[65vh] min-w-0 space-y-4 overflow-y-auto text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <Field label={t('lsp.field.state')}>
                <span data-testid="lsp-state">{t(STATE_LABELS[server.state])}</span>
                {server.failures !== undefined && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('lsp.failures', { count: server.failures })}
                  </span>
                )}
                {server.reason && (
                  <pre className="mt-1 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
                    {server.reason}
                  </pre>
                )}
              </Field>
              {server.name && <Field label={t('lsp.field.server')}>{server.name}</Field>}
              {server.path && (
                <Field label={t('lsp.field.path')}>
                  <span className="font-mono text-xs break-all">{server.path}</span>
                </Field>
              )}
              {server.source && (
                <Field label={t('lsp.field.source')}>{t(SOURCE_LABELS[server.source])}</Field>
              )}
              {(server.version || server.minVersion) && (
                <Field label={t('lsp.field.version')}>
                  {server.version}
                  {server.minVersion && (
                    <span className="text-muted-foreground">
                      {server.version && ' · '}
                      {t('lsp.minVersion', { version: server.minVersion })}
                    </span>
                  )}
                </Field>
              )}
              {server.capabilities && (
                <Field label={t('lsp.field.capabilities')}>
                  <span className="flex flex-wrap gap-1" data-testid="lsp-capabilities">
                    {server.capabilities.map((name) => (
                      <span key={name} className="rounded bg-muted px-1.5 py-px font-mono text-xs">
                        {name}
                      </span>
                    ))}
                  </span>
                </Field>
              )}
              {server.startedAt && (
                <Field label={t('lsp.field.started')}>{time(server.startedAt)}</Field>
              )}
              {server.lastDiagnosticsAt && (
                <Field label={t('lsp.field.diagnostics')}>{time(server.lastDiagnosticsAt)}</Field>
              )}
            </dl>
            {server.install && <InstallRunView server={server} />}
            {server.plans && server.plans.length > 0 && !installing(server) && (
              <InstallPlans key={serverKey(server)} server={server} target={target} />
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {log !== undefined ? (
            <Button variant="outline" onClick={() => setLog(undefined)}>
              {t('lsp.back')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void showLog()}
                data-action="lsp-log"
              >
                {t('lsp.log')}
              </Button>
              <Button
                variant="outline"
                disabled={
                  pending ||
                  installing(server) ||
                  server.state === 'missing' ||
                  server.state === 'outdated'
                }
                onClick={() =>
                  void act(async () => {
                    await client?.request('lsp.restart', ref);
                  })
                }
                data-action="lsp-restart"
              >
                {t('lsp.restart')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InstallRunView({ server }: { server: LspServerStatus }) {
  const { client } = useHostConnection();
  const run = server.install;
  if (run === undefined) return null;
  const busy = installing(server);
  const verified = run.verification;
  return (
    <section className="space-y-2" data-testid="lsp-install-run" data-install-status={run.status}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot
          tone={
            busy
              ? 'accent'
              : run.status === 'succeeded'
                ? 'success'
                : run.status === 'cancelled'
                  ? 'neutral'
                  : 'danger'
          }
          pulse={busy}
        />
        <span className="shrink-0 font-medium">{t(INSTALL_LABELS[run.status])}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {run.command}
        </span>
        <span className="flex-1" />
        {run.status === 'running' && (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void client
                ?.request('lsp.cancelInstall', { installId: run.id })
                .catch(() => undefined)
            }
            data-action="lsp-install-cancel"
          >
            {t('lsp.install.cancel')}
          </Button>
        )}
      </div>
      {verified && (
        <p className="text-xs text-muted-foreground" data-testid="lsp-verified">
          {t('lsp.verified', {
            server: verified.server,
            file: verified.file,
            count: verified.diagnostics,
          })}
        </p>
      )}
      {run.reason && run.status !== 'succeeded' && (
        <pre className="font-mono text-xs whitespace-pre-wrap break-words text-destructive">
          {run.reason}
        </pre>
      )}
      {run.output !== '' && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {run.output}
        </pre>
      )}
    </section>
  );
}

function InstallPlans({ server, target }: { server: LspServerStatus; target: Target }) {
  const { client } = useHostConnection();
  const plans = server.plans ?? [];
  const [planId, setPlanId] = useState(defaultPlan(plans)?.id);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const plan: LspInstallPlan | undefined = plans.find((item) => item.id === planId);
  const global = plan !== undefined && plan.scope !== 'project';

  const install = async () => {
    if (!client || plan === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      await client.request('lsp.install', {
        ...target,
        serverId: server.serverId,
        root: server.root,
        planId: plan.id,
        ...(global && { confirmGlobal: true }),
      });
    } catch (reason) {
      setError(t('lsp.failed', { error: describe(reason) }));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="lsp-plans">
      <h3 className="font-medium">{t('lsp.plans')}</h3>
      <RadioGroup
        value={planId}
        onValueChange={(value) => {
          setPlanId(value as string);
          setConfirmed(false);
        }}
        className="space-y-1.5"
      >
        {plans.map((item) => (
          <div
            key={item.id}
            className="flex min-w-0 items-start gap-1 rounded-lg border border-border py-2 pr-2 pl-3 has-data-checked:border-foreground/40"
            data-plan={item.id}
          >
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
              <Radio value={item.id} className="mt-0.5" />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t(SCOPE_LABELS[item.scope])}</span>
                  {!item.runnable && <span>· {t('lsp.plan.manual')}</span>}
                </span>
                <code className="block font-mono text-xs break-all">{item.command}</code>
                {item.cwd && (
                  <span className="block font-mono text-xs break-all text-muted-foreground">
                    {item.cwd}
                  </span>
                )}
              </span>
            </label>
            <IconButton
              label={copied === item.id ? t('lsp.copied') : t('lsp.copy')}
              size="icon-xs"
              onClick={() =>
                void window.wevir.copyText(item.command).then(() => setCopied(item.id))
              }
            >
              <Copy />
            </IconButton>
          </div>
        ))}
      </RadioGroup>
      {global && plan?.runnable && (
        <label
          className="flex cursor-pointer items-center gap-2 text-sm"
          data-testid="lsp-confirm-global"
        >
          <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
          <span>{t('lsp.confirmGlobal')}</span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        size="sm"
        disabled={
          !client || pending || plan === undefined || !plan.runnable || (global && !confirmed)
        }
        onClick={() => void install()}
        data-action="lsp-install"
      >
        {t('lsp.install')}
      </Button>
    </section>
  );
}

registerRailCard({
  id: 'lsp',
  order: 34,
  title: () => t('rail.lsp'),
  useCard: useLspCard,
});
