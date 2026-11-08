import type { WevirClient } from '@wevir/client-sdk';
import type {
  AccountState,
  ImportSessionCandidate,
  ProviderProfile,
  Session,
} from '@wevir/protocol';
import { accountOfProvider, isPickable, isSourceKind, pickerOrder } from '@/data/sources';
import { projectsOf, type WorkspaceEntry } from '@/data/workbench-model';

export function needsWelcome(done: boolean, workspaces: readonly WorkspaceEntry[]): boolean {
  return (
    !done &&
    projectsOf(workspaces).length === 0 &&
    workspaces.every((entry) => entry.sessions.length === 0)
  );
}

export function welcomeProviders(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
): ProviderProfile[] {
  return pickerOrder(
    providers.filter((provider) => {
      if (!isPickable(provider, accounts)) return false;
      if (!isSourceKind(provider.kind)) return true;
      const account = accountOfProvider(provider, accounts);
      return account?.status === 'signed_in' && account.installed !== false;
    }),
  );
}

export function historiesForProject(
  candidates: readonly ImportSessionCandidate[],
  project: string | undefined,
  entry: WorkspaceEntry | undefined,
): ImportSessionCandidate[] {
  return candidates.filter(
    (candidate) =>
      (candidate.project === project ||
        (entry !== undefined && candidate.workspaceId === entry.workspace.id)) &&
      !entry?.sessions.some(
        (session) =>
          session.origin?.kind === 'imported' &&
          session.origin.app === candidate.app &&
          session.origin.path === candidate.path &&
          session.origin.externalId === candidate.externalId,
      ),
  );
}

export function historyProjects(
  workspaces: readonly WorkspaceEntry[],
  candidates: readonly ImportSessionCandidate[],
): { value: string; label: string }[] {
  const projects = projectsOf(workspaces).map(({ workspace }) => ({
    value: workspace.rootPath,
    label: workspace.displayName,
  }));
  const known = new Set(projects.map((project) => project.value));
  for (const candidate of candidates) {
    if (
      candidate.project === undefined ||
      candidate.workspaceId !== undefined ||
      known.has(candidate.project)
    )
      continue;
    known.add(candidate.project);
    projects.push({ value: candidate.project, label: candidate.project });
  }
  return projects;
}

export async function importHistory(
  client: WevirClient,
  candidate: ImportSessionCandidate,
): Promise<Session> {
  const { results } = await client.request('import.apply', {
    app: candidate.app,
    items: [{ key: candidate.key }],
  });
  const result = results[0];
  if (result?.sessionId === undefined || result.outcome === 'failed')
    throw new Error(result?.reason ?? 'invalid');
  const snapshot = await client.request('session.get', { sessionId: result.sessionId });
  return snapshot.session;
}
