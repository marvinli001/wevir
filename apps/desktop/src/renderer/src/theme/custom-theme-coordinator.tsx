import { useEffect } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { bindCustomThemes } from './custom-theme';

export function CustomThemeCoordinator() {
  const { client } = useHostConnection();
  useEffect(() => (client ? bindCustomThemes(client) : undefined), [client]);
  return null;
}
