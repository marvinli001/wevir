import { cn } from 'cn';
import { Check, MessagesSquare } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useWorkbenchData } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { CenterPage } from './center-page';
import { paths } from './paths';
import { PendingPage } from './route-states';

/**
 * `/`：没有选中会话。不自动跳到第一个工作区或最近的会话（启动时恢复上次会话归 T5.5）。还没有 Provider、
 * 工作区或任何会话时显示首次使用的引导（T5.4）。
 */
export function HomeRoute() {
  const data = useWorkbenchData();
  if (data.status === 'loading') return <PendingPage />;
  if (data.status === 'error') return <PendingPage error={data.error} />;
  const first = data.workspaces[0];
  const hasSessions = data.workspaces.some((entry) => entry.sessions.length > 0);
  if (data.providers.length === 0 || !first || !hasSessions) {
    return (
      <CenterPage>
        <Onboarding hasProvider={data.providers.length > 0} workspace={first} />
      </CenterPage>
    );
  }
  return (
    <CenterPage>
      <EmptyState
        icon={<MessagesSquare />}
        title={t('home.title')}
        action={
          <Button nativeButton={false} render={<Link to={paths.draft(first.workspace.id)} />}>
            {t('home.newSession')}
          </Button>
        }
      >
        <p>{t('home.body')}</p>
      </EmptyState>
    </CenterPage>
  );
}

/** 首次使用的三步：配置 Provider → 添加工作区 → 新建会话。前两步指向设置页，做完的打勾。 */
function Onboarding({
  hasProvider,
  workspace,
}: {
  hasProvider: boolean;
  workspace: WorkspaceEntry | undefined;
}) {
  const location = useLocation();
  const steps = [
    {
      id: 'provider',
      title: t('onboarding.provider'),
      body: t('onboarding.providerBody'),
      done: hasProvider,
      action: t('onboarding.providerAction'),
      to: paths.settings('providers'),
    },
    {
      id: 'workspace',
      title: t('onboarding.workspace'),
      body: t('onboarding.workspaceBody'),
      done: workspace !== undefined,
      action: t('onboarding.workspaceAction'),
      to: paths.settings('workspaces'),
    },
    {
      id: 'session',
      title: t('onboarding.session'),
      body: t('onboarding.sessionBody'),
      done: false,
      action: t('onboarding.sessionAction'),
      to: workspace && hasProvider ? paths.draft(workspace.workspace.id) : undefined,
    },
  ];
  // 当前该做的一步：第一个没做完的。
  const current = steps.findIndex((step) => !step.done);

  return (
    <section className="mx-auto max-w-lg py-10" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title" className="text-xl font-semibold">
        {t('onboarding.title')}
      </h2>
      <p className="mt-2 text-muted-foreground">{t('onboarding.body')}</p>
      <ol className="mt-6 space-y-3">
        {steps.map((step, index) => {
          const active = index === current;
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done || undefined}
              className={cn(
                'flex gap-3 rounded-lg border p-4',
                active ? 'border-primary/40 bg-primary/5' : 'border-border',
              )}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  step.done
                    ? 'bg-success-solid text-primary-foreground'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {step.done ? (
                  <Check className="size-3.5" aria-label={t('onboarding.done')} />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('font-medium', step.done && 'text-muted-foreground')}>
                  {step.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.body}</p>
              </div>
              {step.done ? (
                <span className="shrink-0 self-center text-sm text-success">
                  {t('onboarding.done')}
                </span>
              ) : (
                step.to && (
                  <Button
                    className="shrink-0 self-center"
                    variant={active ? 'default' : 'outline'}
                    nativeButton={false}
                    render={
                      <Link
                        to={step.to}
                        state={step.id === 'session' ? undefined : { from: location }}
                      />
                    }
                  >
                    {step.action}
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
