// “重启以更新”的确认框（照 Claude Code 桌面端退出时的提示）：有会话在进行或后台命令在跑时先问，可以仍然重启、等会话做完再重启
// 或取消。等待期间侧栏入口显示“完成后重启”，再点一次回到这个框。后台命令不等，重启时一并停止。挂在 App 里。

import type { HostProcess } from '@wevir/protocol';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import { platformApi } from '@/platform/platform';
import { blocksRestart, restartBlockers, sessionWorking } from './restart-model';
import { useUpdateState } from './update-store';

interface RestartState {
  /** `checking`：点了重启，正在读后台命令。 */
  dialog: 'closed' | 'checking' | 'open';
  /** 打开确认框时有后台命令在跑的会话数。 */
  processSessions: number;
  /** 选了“等待完成后重启”。 */
  waiting: boolean;
}

const restart = createStore<RestartState>({ dialog: 'closed', processSessions: 0, waiting: false });

/** “重启以更新”按钮调用：没有进行中的工作时直接重启，有就弹确认框。 */
export function requestRestart(): void {
  restart.set((state) => ({ ...state, dialog: 'checking' }));
}

/** 在等会话做完再重启。 */
export function useRestartWaiting(): boolean {
  return restart.use().waiting;
}

function install(): void {
  restart.set((state) => ({ ...state, dialog: 'closed', waiting: false }));
  void platformApi().installUpdate();
}

const NO_PROCESSES: HostProcess[] = [];

export function RestartConfirm() {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const update = useUpdateState();
  const state = restart.use();
  const sessions =
    data.status === 'ready' ? data.workspaces.flatMap((entry) => entry.sessions) : [];
  const working = sessions.filter(sessionWorking).length;
  const downloaded = update?.phase === 'downloaded';

  useEffect(() => {
    if (state.dialog !== 'checking') return;
    let alive = true;
    const listed: Promise<HostProcess[]> = client?.supports('process_output')
      ? client.request('process.list', {}).then(
          (result) => result.processes,
          () => NO_PROCESSES,
        )
      : Promise.resolve(NO_PROCESSES);
    void listed.then((processes) => {
      if (!alive) return;
      const blockers = restartBlockers(
        data.status === 'ready' ? data.workspaces.flatMap((entry) => entry.sessions) : [],
        processes,
      );
      if (!blocksRestart(blockers)) install();
      else
        restart.set((current) => ({
          ...current,
          dialog: 'open',
          processSessions: blockers.processSessions,
        }));
    });
    return () => {
      alive = false;
    };
  }, [state.dialog, client, data]);

  // 等待中：会话都做完了就重启；更新不在“已下载”了（出错、重新检查）就不等了。
  useEffect(() => {
    if (!state.waiting) return;
    if (!downloaded) restart.set((current) => ({ ...current, waiting: false }));
    else if (working === 0 && state.dialog === 'closed') install();
  }, [state.waiting, state.dialog, downloaded, working]);

  const close = (waiting: boolean) =>
    restart.set((current) => ({ ...current, dialog: 'closed', waiting }));

  return (
    <Dialog
      open={state.dialog === 'open'}
      onOpenChange={(open) => {
        if (!open) close(state.waiting);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="restart-confirm">
        <DialogHeader>
          <DialogTitle>
            {working > 0 ? t('update.confirm.sessionsTitle') : t('update.confirm.processesTitle')}
          </DialogTitle>
          <DialogDescription render={<div />} className="space-y-2 leading-relaxed">
            {working > 0 && <p>{t('update.confirm.sessions', { count: working })}</p>}
            {state.processSessions > 0 && (
              <p>{t('update.confirm.processes', { count: state.processSessions })}</p>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {state.waiting ? t('update.confirm.stopWaiting') : t('common.cancel')}
          </Button>
          <Button variant={working > 0 ? 'destructive' : 'default'} onClick={install} data-confirm>
            {t('update.confirm.restart')}
          </Button>
          {working > 0 && (
            <Button onClick={() => close(true)} data-wait>
              {state.waiting ? t('update.confirm.keepWaiting') : t('update.confirm.wait')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
