import type { ImportApp, ImportScanResult } from '@wevir/protocol';
import { TriangleAlert } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';

export function ImportSessionIssues({
  issues,
  app,
  compact = false,
}: {
  issues: ImportScanResult['sessionIssues'];
  app?: ImportApp;
  compact?: boolean;
}) {
  const location = useLocation();
  if (!issues?.length) return null;
  if (compact)
    return (
      <Link
        to={paths.settings('import')}
        state={{ from: location, importApp: app }}
        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-sm text-sm text-soft-foreground outline-none hover:underline focus-visible:focus-field"
      >
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-icon-warning" />
        {t('settings.import.sessionIssues', { count: issues.length })}
      </Link>
    );
  return (
    <details className="text-sm text-soft-foreground">
      <summary className="cursor-pointer rounded-sm outline-none focus-visible:focus-field">
        <TriangleAlert
          aria-hidden
          className="mr-1.5 inline size-3.5 align-[-0.15em] text-icon-warning"
        />
        {t('settings.import.sessionIssues', { count: issues.length })}
      </summary>
      <ul className="mt-2 space-y-1 text-xs break-words">
        {issues.map((issue) => (
          <li key={issue.path}>
            <span className="font-mono">{issue.path}</span> ·{' '}
            {t(
              issue.reason === 'invalid'
                ? 'settings.import.reason.invalid'
                : 'settings.import.unreadable',
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
