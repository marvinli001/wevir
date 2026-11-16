import { useEffect } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { platformApi } from '@/platform/platform';
import { bindCustomThemes, restoreDefaultTheme } from './custom-theme';

export function CustomThemeCoordinator() {
  const { client } = useHostConnection();
  useEffect(() => (client ? bindCustomThemes(client) : undefined), [client]);
  useEffect(() => platformApi().onRestoreDefaultTheme(restoreDefaultTheme), []);
  return null;
}
