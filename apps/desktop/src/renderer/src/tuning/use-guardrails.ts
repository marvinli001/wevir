// 档案里护栏层的数据（0.86.0）：这个范围的护栏规则（`guardrail.list`）与项目的仓库 hooks（`repoHook.list`；Host 有生命周期钩子时
// 是 `hook.list`，0.137.0，全部来源，全局范围也有）。`guardrail.changed` 来了
// 且范围对得上（全局的规则对所有范围都算；重连后收到 undefined）就重读，同一刻的几条合成一次；仓库里的 hooks 文件改了 Host 不通知，
// 窗口回到前台时也重读。重读时留着上次的结果。

import type { WevirClient } from '@wevir/client-sdk';
import type { Guardrail, Hook, RepoHook, WorkspaceId } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

/** 列表里的一条 hook：`hook.list` 的，或旧 Host 的 `repoHook.list` 的（没有来源与引擎）。 */
export type ListedHook = RepoHook | Hook;

export interface GuardrailsData {
  guardrails: Guardrail[];
  hooks: ListedHook[];
  warnings: string[];
}

const COALESCE_MS = 150;

export function useGuardrails(
  client: WevirClient,
  workspaceId: string | undefined,
  lifecycleHooks = false,
) {
  const [state, setState] = useState<{ data?: GuardrailsData; error?: unknown; scope?: string }>(
    {},
  );
  const seq = useRef(0);
  const key = workspaceId ?? 'global';
  const reload = useCallback(() => {
    const id = ++seq.current;
    const workspace = workspaceId as WorkspaceId | undefined;
    Promise.all([
      client.request('guardrail.list', workspace === undefined ? {} : { workspaceId: workspace }),
      lifecycleHooks
        ? client.request('hook.list', workspace === undefined ? {} : { workspaceId: workspace })
        : workspace === undefined
          ? Promise.resolve({ hooks: [], warnings: [] })
          : client.request('repoHook.list', { workspaceId: workspace }),
    ]).then(
      ([listed, hooks]) => {
        if (id !== seq.current) return;
        setState({
          scope: key,
          data: { guardrails: listed.guardrails, hooks: hooks.hooks, warnings: hooks.warnings },
        });
      },
      (error: unknown) => {
        if (id === seq.current) setState((previous) => ({ ...previous, error, scope: key }));
      },
    );
  }, [client, workspaceId, key, lifecycleHooks]);

  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        reload();
      }, COALESCE_MS);
    };
    const off = client.onGuardrailsChanged((change) => {
      if (change?.workspaceId !== undefined && change.workspaceId !== workspaceId) return;
      schedule();
    });
    window.addEventListener('focus', schedule);
    return () => {
      off();
      window.removeEventListener('focus', schedule);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, reload, workspaceId]);

  const fresh = state.scope === key;
  return {
    ...(fresh && state.data !== undefined && { data: state.data }),
    ...(fresh && state.error !== undefined && { error: state.error }),
    reload,
  };
}
