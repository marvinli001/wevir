import type { Session } from '@wevir/protocol';
import type { EffectCallback, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findElement, hooks } from '../test-hooks.test-utils';
import { FromHistoryDialog } from './from-history-dialog';

const h = vi.hoisted(() => ({ request: vi.fn(), change: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../test-hooks.test-utils')),
  useEffect: (effect: EffectCallback) => hooks.effects.push(effect),
  useId: () => 'trust_fixture',
}));
vi.mock('@/host/host-connection', () => ({
  describe: String,
  useHostConnection: () => ({
    client: { request: h.request, can: () => true },
    view: {
      status: 'connected',
      hello: { protocolVersion: '0.189.0', features: { sync_workspace: true } },
    },
  }),
}));
vi.mock('@/data/workbench-data', () => ({ useWorkbenchStore: () => undefined }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./start-session', () => ({
  useModelChoice: () => ({ providers: [], choose: vi.fn() }),
  resolveChoice: () => undefined,
}));
vi.mock('@/i18n', () => ({ t: (key: string) => key, currentLocale: () => 'zh-CN' }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  hooks.reset();
});

describe('history continuation dismissal', () => {
  it('clears the previous error when the dialog closes', () => {
    hooks.reset([undefined, false, 'Previous failure']);
    hooks.render(() =>
      FromHistoryDialog({
        session: { id: 'ses_fixture', workspaceId: 'ws_fixture' } as unknown as Session,
        open: false,
        onOpenChange: h.change,
      }),
    );
    hooks.effects[0]?.();
    expect(hooks.values[2]).toBeUndefined();
  });
  it('keeps trusted paths outside the checkbox label and describes them by ID', () => {
    hooks.reset([
      undefined,
      false,
      undefined,
      [],
      '',
      { requiresTrust: ['.claude/skills/synthetic/SKILL.md'], restoreId: 'restore_fixture' },
    ]);
    const tree = hooks.render(() =>
      FromHistoryDialog({
        session: { id: 'ses_fixture', workspaceId: 'ws_fixture' } as unknown as Session,
        open: true,
        onOpenChange: h.change,
      }),
    );
    const label = findElement(tree, (element) => element.type === 'label');
    expect(() => findElement(label, (element) => element.type === 'ul')).toThrow(
      'missing test element',
    );
    const list = findElement(tree, (element) => element.type === 'ul');
    expect(list.props.id).toBeTruthy();
    expect(
      findElement(label, (element) => element.props['aria-describedby'] === list.props.id),
    ).toBeDefined();
  });
  it('closes immediately when workspace disposal fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.request.mockRejectedValue(new Error('Host unavailable'));
    const tree = hooks.render(() =>
      FromHistoryDialog({
        session: { id: 'ses_fixture', workspaceId: 'ws_fixture' } as unknown as Session,
        open: true,
        onOpenChange: h.change,
      }),
    );
    (hooks.refs[0] as { current: Map<string, unknown> }).current.set('snapshot', {
      restoreId: 'restore_fixture',
    });
    const dialog = findElement(
      tree as ReactNode,
      (element) => typeof element.props.onOpenChange === 'function',
    );
    (dialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(h.change).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(hooks.values[2]).toBeUndefined();
  });
});
