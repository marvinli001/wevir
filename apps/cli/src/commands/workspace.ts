import { resolve } from 'node:path';
import { type Context, withClient } from '../context.js';
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

export async function workspaceList(ctx: Context): Promise<number> {
  const { workspaces } = await withClient(ctx, (client) => client.request('workspace.list'));
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
