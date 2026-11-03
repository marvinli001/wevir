import type { SessionId, TurnId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { PaneController } from '@/layout/pane-controller';
import { openChanges, selectFolder, selectScope, useChangesSelection } from './changes-store';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

const first = 'ses_first' as SessionId;
const second = 'ses_second' as SessionId;

describe('变更选择', () => {
  it('范围切换和回合往返保留目录，会话分别记住选择', () => {
    selectFolder(first, '/api');
    selectScope(first, { kind: 'branch' }, 'src/a.ts', 12);
    const reveal = useChangesSelection(first).reveal;
    expect(useChangesSelection(first)).toMatchObject({ folder: '/api', scope: { kind: 'branch' } });
    selectScope(first, { kind: 'turn', turnId: 'trn_one' as TurnId });
    selectFolder(second, '/docs');
    selectScope(first, { kind: 'staged' });
    expect(useChangesSelection(first)).toEqual({ folder: '/api', scope: { kind: 'staged' } });
    expect(useChangesSelection(second).folder).toBe('/docs');
    expect(reveal).toMatchObject({ path: 'src/a.ts', line: 12 });
    openChanges(undefined, first, { kind: 'turn', turnId: 'trn_one' as TurnId });
    expect(useChangesSelection(first).folder).toBe('/api');
  });

  it('选择另一个目录清除旧文件定位', () => {
    selectScope(first, { kind: 'uncommitted' }, 'same.ts', 4);
    selectFolder(first, '/other');
    expect(useChangesSelection(first)).toEqual({
      folder: '/other',
      scope: { kind: 'uncommitted' },
    });
  });

  it('仓库行指定目录和未提交范围，覆盖先前的目录与回合', () => {
    const open = vi.fn();
    const panes = { open } as unknown as PaneController;
    selectFolder(first, '/other');
    selectScope(first, { kind: 'turn', turnId: 'trn_one' as TurnId });
    openChanges(panes, first, { kind: 'uncommitted' }, '/api');
    expect(useChangesSelection(first)).toEqual({ folder: '/api', scope: { kind: 'uncommitted' } });
    expect(open).toHaveBeenCalledWith({ kind: 'changes' });
  });

  it.each(['branch', 'staged', 'uncommitted'] as const)(
    '主目录文件入口定位范围与行：%s',
    (kind) => {
      selectFolder(first, '/api');
      openChanges(undefined, first, { kind: 'turn', turnId: 'trn_one' as TurnId });
      openChanges(undefined, first, { kind }, '/app', 'src/a.ts', 8);
      const before = useChangesSelection(first);
      expect(before.folder).toBe('/app');
      expect(before.scope).toEqual({ kind });
      expect(before.reveal).toMatchObject({ path: 'src/a.ts', line: 8 });
      openChanges(undefined, first, { kind }, '/app', 'src/a.ts', 8);
      expect(useChangesSelection(first).reveal?.id).not.toBe(before.reveal?.id);
    },
  );
});
