// 输入栏的草稿：每个会话、助理与新建会话各一份，离开页面再回来还在；发出后清掉。只在内存里，App 退出就没了（照片不留）。

const drafts = new Map<string, string>();

export function readDraft(key: string): string {
  return drafts.get(key) ?? '';
}

export function writeDraft(key: string, text: string): void {
  if (text === '') drafts.delete(key);
  else drafts.set(key, text);
}
