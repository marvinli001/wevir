import { resolve } from 'node:path';
import { type Context, findWorkspace, withClient } from '../context.js';
import { EXIT } from '../errors.js';
import { formatTime, table } from '../format.js';
import { t } from '../i18n/index.js';

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
  const params = { name: workspace.displayName, id: workspace.id };
  ctx.print(created ? t('workspace.added', params) : t('workspace.exists', params));
  ctx.print(ctx.styles.dim(workspace.rootPath));
  return EXIT.ok;
}

export async function workspaceList(
  ctx: Context,
  options: { json?: boolean } = {},
): Promise<number> {
  const { workspaces } = await withClient(ctx, (client) => client.request('workspace.list'));
  if (options.json) {
    ctx.print(JSON.stringify(workspaces, null, 2));
    return EXIT.ok;
  }
  if (workspaces.length === 0) {
    ctx.print(t('workspace.none'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      ['ID', t('workspace.col.name'), t('workspace.col.path'), t('workspace.col.added')],
      workspaces.map((w) => [w.id, w.displayName, w.rootPath, formatTime(w.createdAt)]),
    ),
  );
  return EXIT.ok;
}

/** `wevir workspace remove <路径>`：不再列出这个工作区和它的会话；目录与文件不动。 */
export async function workspaceRemove(ctx: Context, path: string): Promise<number> {
  return withClient(ctx, async (client) => {
    const { workspaces } = await client.request('workspace.list');
    const workspace = await findWorkspace(ctx, workspaces, path);
    await client.request('workspace.remove', { workspaceId: workspace.id });
    ctx.print(t('workspace.removed', { name: workspace.displayName }));
    return EXIT.ok;
  });
}

/** `wevir workspace rename <路径> <名称>`。 */
export async function workspaceRename(ctx: Context, path: string, name: string): Promise<number> {
  return withClient(ctx, async (client) => {
    const { workspaces } = await client.request('workspace.list');
    const found = await findWorkspace(ctx, workspaces, path);
    const { workspace } = await client.request('workspace.update', {
      workspaceId: found.id,
      displayName: name,
    });
    ctx.print(t('workspace.renamed', { name: workspace.displayName }));
    return EXIT.ok;
  });
}
