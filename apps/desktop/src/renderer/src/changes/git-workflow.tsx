import { isRpcError } from '@wevir/client-sdk';
import type { GitBranchExpected, GitStatusResult, MethodParams } from '@wevir/protocol';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
} from 'lucide-react';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { describe, useCan, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { expectedOf } from './git-data';

type Action = 'switch' | 'push' | 'pr';
type Scope = MethodParams<'git.status'>;
type Choices = { options: string[]; expected: GitBranchExpected };
type Success = { kind: 'push'; branch: string; remote: string } | { kind: 'pr'; url: string };
const labels = { switch: 'git.switchBranch', push: 'git.push', pr: 'git.createPr' } as const;

export function GitWorkflowMenu({
  scope,
  status,
  refresh,
}: {
  scope: Scope;
  status: GitStatusResult;
  refresh: () => void;
}) {
  const [action, setAction] = useState<Action>();
  const publish = useCan('git.publish');
  const trigger = useRef<HTMLButtonElement>(null);
  const current = status.branch ?? status.head?.slice(0, 7) ?? 'Git';
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              variant="ghost"
              size="xs"
              className="-ml-1.5 min-w-0 shrink gap-1 px-1.5 font-normal text-muted-foreground"
              aria-label={t('git.branchActions', { branch: current })}
              data-action="git-workflow"
            />
          }
        >
          <GitBranch aria-hidden />
          <span className="truncate font-mono" data-commit-branch>
            {current}
          </span>
          <ChevronDown aria-hidden className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onClick={() => setAction('switch')}>
            <GitBranch />
            {t(labels.switch)}
          </DropdownMenuItem>
          {publish && (
            <>
              <DropdownMenuItem
                disabled={!status.branch || !status.head}
                onClick={() => setAction('push')}
              >
                <ArrowUp />
                {t(labels.push)}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!status.branch || !status.head}
                onClick={() => setAction('pr')}
              >
                <GitPullRequest />
                {t(labels.pr)}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {action && (action === 'switch' || publish) && (
        <WorkflowDialog
          action={action}
          scope={scope}
          refresh={refresh}
          trigger={trigger}
          onClose={() => setAction(undefined)}
        />
      )}
    </>
  );
}

function WorkflowDialog({
  action,
  scope,
  refresh,
  trigger,
  onClose,
}: {
  action: Action;
  scope: Scope;
  refresh: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { client } = useHostConnection();
  const fieldId = useId();
  const { workspaceId, sessionId, folder } = scope;
  const [choices, setChoices] = useState<Choices>();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<Success>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是用户手动刷新仓库。
  useEffect(() => {
    if (!client) return;
    let active = true;
    const params = { workspaceId, ...(sessionId && { sessionId }), ...(folder && { folder }) };
    setChoices(undefined);
    setError(undefined);
    Promise.all([client.request('git.branches', params), client.request('git.status', params)])
      .then(([refs, status]) => {
        if (!active) return;
        const expected = expectedOf(status);
        if (
          !expected ||
          refs.current !== status.branch ||
          (action !== 'switch' && (!status.branch || !status.head))
        ) {
          setError(t('git.reloadState'));
          return;
        }
        const options =
          action === 'switch'
            ? refs.branches.filter((branch) => branch !== refs.current)
            : refs.remotes;
        setChoices({ options, expected: { ...expected, branch: status.branch ?? null } });
      })
      .catch((cause: unknown) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, sessionId, folder, revision, action]);

  const switching = action === 'switch';
  const options = choices?.options ?? [];
  const destination = options.includes(selected)
    ? selected
    : !switching && options.includes('origin')
      ? 'origin'
      : (options[0] ?? '');
  const ready = !!client && !!choices && !!destination && (action !== 'pr' || !!title.trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !choices || !ready || busy) return;
    setBusy(true);
    setError(undefined);
    const { expected } = choices;
    try {
      if (switching) {
        await client.request('git.switchBranch', { ...scope, branch: destination, expected });
        refresh();
        onClose();
      } else if (action === 'push') {
        if (expected.branch === null) return;
        await client.request(
          'git.push',
          { ...scope, remote: destination, expected },
          { timeoutMs: 660_000 },
        );
        refresh();
        setSuccess({ kind: 'push', branch: expected.branch, remote: destination });
      } else {
        const { url } = await client.request(
          'git.createPullRequest',
          {
            ...scope,
            remote: destination,
            title: title.trim(),
            ...(base.trim() && { base: base.trim() }),
            ...(details.trim() && { body: details }),
            expected,
          },
          { timeoutMs: 180_000 },
        );
        setSuccess({ kind: 'pr', url });
      }
    } catch (cause) {
      if (isRpcError(cause, 'GIT_STATE_CHANGED')) {
        setChoices(undefined);
        setError(t('git.reloadState'));
        refresh();
      } else setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        finalFocus={trigger}
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-3rem)] gap-4 overflow-y-auto p-5 sm:max-w-96"
      >
        <DialogTitle className="pr-7">{t(labels[action])}</DialogTitle>
        {success ? (
          <>
            <p role="status" className="flex items-center gap-2 break-all text-sm">
              <Check className="size-4 shrink-0 text-icon-success" aria-hidden />
              {success.kind === 'pr'
                ? t('git.prCreated')
                : t('git.pushed', { branch: success.branch, remote: success.remote })}
            </p>
            {success.kind === 'pr' && (
              <a
                href={success.url}
                onClick={(event) => {
                  event.preventDefault();
                  void platformApi()
                    .openExternal(event.currentTarget.href)
                    .catch((cause) => setError(describe(cause)));
                }}
                className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground underline decoration-current/40 underline-offset-2 outline-none focus-visible:focus-ring"
              >
                <span className="min-w-0 truncate">{success.url}</span>
                <ExternalLink aria-hidden className="size-3.5 shrink-0" />
              </a>
            )}
            {error && <ErrorNote className="text-sm">{error}</ErrorNote>}
          </>
        ) : (
          <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
            {choices && (
              <>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">
                    {choices.expected.branch ?? choices.expected.head?.slice(0, 7)}
                  </span>
                </div>
                {options.length ? (
                  <label htmlFor={`${fieldId}-target`} className="grid gap-1.5 text-sm">
                    {t(switching ? 'git.targetBranch' : 'git.remote')}
                    <Select
                      id={`${fieldId}-target`}
                      value={destination}
                      disabled={busy}
                      options={options.map((value) => ({ value, label: value }))}
                      onValueChange={setSelected}
                      aria-label={t(switching ? 'git.targetBranch' : 'git.remote')}
                    />
                  </label>
                ) : (
                  <p className="text-sm text-muted-foreground" role="status">
                    {t(switching ? 'git.noBranches' : 'git.noRemotes')}
                  </p>
                )}
                {action === 'pr' && options.length > 0 && (
                  <>
                    <label htmlFor={`${fieldId}-title`} className="grid gap-1.5 text-sm">
                      {t('git.prTitle')}
                      <Input
                        id={`${fieldId}-title`}
                        required
                        maxLength={256}
                        value={title}
                        disabled={busy}
                        onChange={(event) => setTitle(event.target.value)}
                      />
                    </label>
                    <label htmlFor={`${fieldId}-base`} className="grid gap-1.5 text-sm">
                      {t('git.prBase')}
                      <Input
                        id={`${fieldId}-base`}
                        className="font-mono"
                        spellCheck={false}
                        value={base}
                        disabled={busy}
                        onChange={(event) => setBase(event.target.value)}
                      />
                    </label>
                    <label htmlFor={`${fieldId}-details`} className="grid gap-1.5 text-sm">
                      {t('git.prDetails')}
                      <Textarea
                        id={`${fieldId}-details`}
                        rows={3}
                        maxLength={65_536}
                        value={details}
                        disabled={busy}
                        onChange={(event) => setDetails(event.target.value)}
                      />
                    </label>
                  </>
                )}
              </>
            )}
            {!choices && !error && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('common.loading')}
              </p>
            )}
            {error && (
              <ErrorNote className="max-h-40 overflow-auto text-sm whitespace-pre-wrap">
                {error}
              </ErrorNote>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              {!choices && error ? (
                <Button type="button" onClick={() => setRevision((value) => value + 1)}>
                  {t('changes.refresh')}
                </Button>
              ) : (
                <Button type="submit" disabled={!ready || busy} data-action="git-workflow-submit">
                  {busy && <LoaderCircle aria-hidden className="animate-spin" />}
                  {t(labels[action])}
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
