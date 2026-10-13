import { resolve } from 'node:path';
import { type Context, withClient } from '../context.js';
import { EXIT } from '../errors.js';
import { formatTime, table } from '../format.js';

export async function workspaceAdd(
  ctx: Context,
  path: string,
  options: { name?: string },
): Promise<number> {
  const rootPath = resolve(ctx.io.cwd, path);
  const { workspace, created } = await withClient(ctx, (client) =>
    client.request('workspace.add', {
      rootPath,
      ...(options.name !== undefined && { displayName: options.name }),
    }),
  );
  ctx.print(
    `${created ? '已添加工作区' : '工作区已存在'}：${workspace.displayName}（${workspace.id}）`,
  );
  ctx.print(ctx.styles.dim(workspace.rootPath));
  return EXIT.ok;
}

export async function workspaceList(ctx: Context): Promise<number> {
  const { workspaces } = await withClient(ctx, (client) => client.request('workspace.list'));
  if (workspaces.length === 0) {
    ctx.print('还没有工作区。');
    ctx.print(ctx.styles.dim('下一步：wevir workspace add <路径>'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      ['ID', '名称', '路径', '添加于'],
      workspaces.map((w) => [w.id, w.displayName, w.rootPath, formatTime(w.createdAt)]),
    ),
  );
  return EXIT.ok;
}
