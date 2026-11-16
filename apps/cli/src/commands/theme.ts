import { type Context, requireFeature, withClient } from '../context.js';
import { EXIT } from '../errors.js';
import { table } from '../format.js';
import { t } from '../i18n/index.js';

export function themeList(ctx: Context, json = false): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'themes');
    const result = await client.request('themes.list');
    ctx.print(
      json
        ? JSON.stringify(result, null, 2)
        : table(
            [t('theme.col.id'), t('theme.col.name'), t('theme.col.active')],
            result.themes.map((theme) => [
              theme.id,
              theme.name,
              theme.id === result.activeId ? '*' : '',
            ]),
          ),
    );
    return EXIT.ok;
  });
}

export function themeSet(ctx: Context, id: string | null): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'themes');
    await client.request('themes.setActive', { id });
    ctx.print(id === null ? t('theme.cleared') : t('theme.applied', { id }));
    return EXIT.ok;
  });
}
