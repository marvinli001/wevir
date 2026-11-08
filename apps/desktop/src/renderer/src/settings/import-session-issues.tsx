import type { ImportApp, ImportScanResult } from '@wevir/protocol';
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
        className="shrink-0 self-start rounded-sm text-sm text-warning outline-none hover:underline focus-visible:focus-field"
      >
        {t('settings.import.sessionIssues', { count: issues.length })}
      </Link>
    );
  return (
    <details className="text-sm text-warning">
      <summary className="cursor-pointer rounded-sm outline-none focus-visible:focus-field">
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
