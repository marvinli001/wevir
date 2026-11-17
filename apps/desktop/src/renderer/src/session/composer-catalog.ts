import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { SessionId } from '@wevir/protocol';
import { SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { describe, useCan } from '@/host/host-connection';
import type { ComposerCommand } from './composer-commands';

interface Catalog {
  skills: readonly { name: string; description?: string | undefined }[];
  commands: readonly {
    name: string;
    description?: string | undefined;
    argumentHint?: string | undefined;
  }[];
}
const empty: Catalog = { skills: [], commands: [] };
export function useComposerCatalog(
  client: WevirClient | undefined,
  sessionId: SessionId | undefined,
  draftSkills: boolean,
  providerId: string | undefined,
  active: boolean,
  local: readonly ComposerCommand[] | undefined,
) {
  const canRead = useCan('host.manage');
  const key = JSON.stringify([sessionId, providerId]);
  const [result, setResult] = useState<{
    key: string;
    catalog: Catalog;
    error?: string;
    loading?: boolean;
  }>();
  const sessionCatalog =
    client && sessionId && hostSupports(client.hello.features, 'session_composer_catalog');
  const plugins =
    client &&
    !sessionId &&
    draftSkills &&
    canRead &&
    hostSupports(client.hello.features, 'plugins');
  useEffect(() => {
    if (!client || !active || (!sessionCatalog && !plugins)) return;
    let current = true;
    setResult({ key, catalog: empty, loading: true });
    const load =
      sessionCatalog && sessionId
        ? client.request('session.composerCatalog', { sessionId })
        : client
            .request('plugins.list')
            .then((list) => ({ skills: list.skills.filter((s) => s.enabled), commands: [] }));
    void load.then(
      (catalog) => current && setResult({ key, catalog }),
      (error) => current && setResult({ key, catalog: empty, error: describe(error) }),
    );
    return () => {
      current = false;
    };
  }, [active, client, key, plugins, sessionCatalog, sessionId]);
  const current = result?.key === key ? result : undefined;
  const catalog = sessionCatalog || plugins ? (current?.catalog ?? empty) : empty;
  const commands = useMemo(() => {
    if (!catalog.commands.length) return local;
    const native = catalog.commands.filter((c) => !local?.some((own) => own.name === c.name));
    return [
      ...(local ?? []),
      ...native.map(
        (command): ComposerCommand => ({
          name: command.name,
          label: `/${command.name}`,
          icon: SquareTerminal,
          insert: `/${command.name} `,
          ...((command.argumentHint || command.description) && {
            detail: command.argumentHint || command.description,
          }),
        }),
      ),
    ];
  }, [local, catalog.commands]);
  return {
    commands,
    skills: catalog.skills,
    available: !!sessionCatalog || !!plugins,
    loading: active && !!(sessionCatalog || plugins) && (!current || current.loading),
    error: current?.error,
  };
}
