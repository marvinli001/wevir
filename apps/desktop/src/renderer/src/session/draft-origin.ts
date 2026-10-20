// 新会话草稿页的草稿归属与路由 state：“基于历史新建”（T5.5）与“基于回顾新建”（0.73.0）把材料放进草稿页的输入框，沿用原会话的
// Provider，用户确认后才发送。

/** 新会话草稿页输入框的草稿归属。 */
export function newSessionDraftKey(workspaceId: string): string {
  return `draft:${workspaceId}`;
}

/** 从一个会话新建时带给草稿页的路由 state。 */
export interface DraftOrigin {
  providerId: string;
  fromTitle: string;
  /** 材料是什么：对话记录（默认）或任务回顾。 */
  material?: 'retro';
}

export function draftOrigin(state: unknown): DraftOrigin | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const { providerId, fromTitle, material } = state as Record<string, unknown>;
  if (typeof providerId !== 'string' || typeof fromTitle !== 'string') return undefined;
  return { providerId, fromTitle, ...(material === 'retro' && { material }) };
}
