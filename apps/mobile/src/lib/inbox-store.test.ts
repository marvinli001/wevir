import { WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode, type InboxItem } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNotVerifiedError, setApprovalGate } from './approval-gate';
import type { LinkStatus } from './computer-link';
import type { InboxChange } from './inbox';
import { type InboxClient, type InboxSource, InboxStore } from './inbox-store';
import { approvalItem, failedItem } from './inbox-test-utils';
import type { ComputerRecord } from './records';
import { record } from './test-utils';

/** 一台电脑的假 Host：收件箱在内存里，作答按“首个决定生效”。 */
class FakeHost {
  items: InboxItem[] = [];
  version = 10;
  decided = new Map<string, { status: string; clientId: string; kind: string; at: string }>();
  requests: Array<{ method: string; params: unknown }> = [];
  listeners = new Set<(change: InboxChange | undefined) => void>();
  lists = 0;

  constructor(readonly clientId: string) {}

  client(): InboxClient {
    return {
      canWrite: true,
      identity: { clientId: this.clientId },
      listInbox: async () => {
        this.lists += 1;
        return { items: [...this.items], inboxVersion: this.version };
      },
      onInboxChanged: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      request: (async (method: string, params: Record<string, string>) => {
        this.requests.push({ method, params });
        if (method === 'approval.respond') return this.respond(params, this.clientId);
        if (method === 'inbox.dismiss') return {};
        throw new Error(`unexpected ${method}`);
      }) as InboxClient['request'],
    };
  }

  /** 某个客户端回审批：已结算就回 ALREADY_DECIDED。 */
  respond(params: Record<string, string>, clientId: string, kind = 'mobile') {
    const id = params.approvalId as string;
    const previous = this.decided.get(id);
    if (previous !== undefined) {
      throw new WevirRpcError('approval.respond', {
        code: ErrorCode.ALREADY_DECIDED,
        message: 'approval already decided',
        data: {
          approvalId: id,
          status: previous.status,
          resolution: {
            reason: 'user',
            optionId: 'allow-once',
            decidedBy: { deviceId: 'd', clientId: previous.clientId, clientKind: previous.kind },
          },
          resolvedAt: previous.at,
        },
      });
    }
    const status = params.optionId === 'allow-once' ? 'approved' : 'denied';
    this.decided.set(id, { status, clientId, kind, at: '2026-10-27T08:02:00.000Z' });
    return { approvalId: id, status, resolution: { reason: 'user' } };
  }

  push(change: Omit<InboxChange, 'inboxVersion'>, version = this.version + 1) {
    this.version = version;
    const ids = new Set([...change.removed, ...change.upserted.map((i) => i.id)]);
    this.items = [...change.upserted, ...this.items.filter((i) => !ids.has(i.id))];
    for (const listener of this.listeners) listener({ ...change, inboxVersion: version });
  }
}

class FakeSource implements InboxSource {
  snapshots: { record: ComputerRecord; status: LinkStatus }[] = [];
  links = new Map<string, { inbox?: InboxClient; connection?: object }>();
  listeners = new Set<() => void>();

  add(name: string, host: FakeHost | undefined) {
    this.snapshots = [
      ...this.snapshots.filter((s) => s.record.name !== name),
      {
        record: record({ name, hostName: name.toUpperCase() }),
        status: host
          ? { kind: 'online', route: 'direct' }
          : { kind: 'offline', reason: 'unreachable' },
      },
    ];
    this.links.set(name, host ? { inbox: host.client(), connection: {} } : {});
    for (const listener of this.listeners) listener();
  }

  link(name: string) {
    return this.links.get(name);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const risky = (id: string) => {
  const item = approvalItem(id);
  if (item.kind === 'approval')
    item.ref = { ...item.ref, risk: { level: 'high', reasons: ['destructive_command'] } };
  return item;
};

describe('InboxStore', () => {
  let offGate: (() => void) | undefined;
  afterEach(() => offGate?.());

  it('两台电脑的收件箱合成一个列表；离线的电脑记下来', async () => {
    const studio = new FakeHost('mobile-s');
    studio.items = [approvalItem('apr_1', { createdAt: '2026-10-27T07:00:00.000Z' })];
    const mini = new FakeHost('mobile-m');
    mini.items = [
      failedItem('trn_1', '2026-10-27T09:00:00.000Z'),
      approvalItem('apr_2', { createdAt: '2026-10-27T08:00:00.000Z' }),
    ];
    const source = new FakeSource();
    source.add('studio', studio);
    source.add('mini', mini);
    source.add('laptop', undefined);
    const store = new InboxStore(source);
    store.start();
    await settle();
    expect(store.snapshot.entries.map((e) => `${e.computerName} ${e.item.id}`)).toEqual([
      'MINI approval:apr_2',
      'STUDIO approval:apr_1',
      'MINI turn_failed:trn_1',
    ]);
    expect(store.snapshot.unavailable).toEqual(['LAPTOP']);
    expect(store.snapshot.loading).toBe(false);
    store.stop();
  });

  it('跟着 inbox.changed；版本接不上与重连后重读', async () => {
    const studio = new FakeHost('mobile-s');
    const source = new FakeSource();
    source.add('studio', studio);
    const store = new InboxStore(source);
    store.start();
    await settle();
    expect(studio.lists).toBe(1);
    studio.push({ upserted: [approvalItem('apr_1')], removed: [] });
    expect(store.snapshot.entries.map((e) => e.item.id)).toEqual(['approval:apr_1']);
    studio.push({ upserted: [approvalItem('apr_2')], removed: ['approval:apr_1'] }, 20);
    await settle();
    expect(studio.lists).toBe(2);
    expect(store.snapshot.entries.map((e) => e.item.id)).toEqual(['approval:apr_2']);
    for (const listener of studio.listeners) listener(undefined);
    await settle();
    expect(studio.lists).toBe(3);
    // 换了连接（回到前台）：重读，旧的退订。
    source.add('studio', studio);
    await settle();
    expect(studio.lists).toBe(4);
    expect(studio.listeners.size).toBe(1);
    store.stop();
    expect(studio.listeners.size).toBe(0);
  });

  it('下拉刷新重读每台连着的电脑，读完才完成', async () => {
    const studio = new FakeHost('mobile-s');
    const source = new FakeSource();
    source.add('studio', studio);
    source.add('laptop', undefined);
    const store = new InboxStore(source);
    store.start();
    await settle();
    studio.items = [approvalItem('apr_1')];
    await store.refresh();
    expect(studio.lists).toBe(2);
    expect(store.snapshot.entries.map((e) => e.item.id)).toEqual(['approval:apr_1']);
    store.stop();
  });

  it('手机批准与电脑上同时作答：后到的说明已在别处处理，写明谁、何时', async () => {
    const studio = new FakeHost('mobile-s');
    studio.items = [approvalItem('apr_1')];
    const source = new FakeSource();
    source.add('studio', studio);
    const store = new InboxStore(source);
    store.start();
    await settle();
    const [entry] = store.snapshot.entries;
    if (entry === undefined) throw new Error('no entry');
    // 电脑上先点了允许。
    studio.respond({ approvalId: 'apr_1', optionId: 'allow-once' }, 'desk-1', 'desktop');
    const outcome = await store.respondApproval(entry, 'reject-once');
    expect(outcome).toEqual({
      kind: 'elsewhere',
      by: 'desktop',
      at: '2026-10-27T08:02:00.000Z',
      result: 'approved',
    });
    expect(store.snapshot.entries).toEqual([]);
    expect(store.snapshot.settled).toEqual([{ entry, outcome }]);
    store.acknowledge(entry.key);
    expect(store.snapshot.settled).toEqual([]);
    store.stop();
  });

  it('重复作答：第一次成功，第二次说明本机已处理', async () => {
    const studio = new FakeHost('mobile-s');
    studio.items = [approvalItem('apr_1')];
    const source = new FakeSource();
    source.add('studio', studio);
    const store = new InboxStore(source);
    store.start();
    await settle();
    const [entry] = store.snapshot.entries;
    if (entry === undefined) throw new Error('no entry');
    expect(await store.respondApproval(entry, 'allow-once')).toEqual({ kind: 'done' });
    expect(store.snapshot.entries).toEqual([]);
    expect(await store.respondApproval(entry, 'allow-once')).toMatchObject({
      kind: 'elsewhere',
      by: 'this_device',
      result: 'approved',
    });
    store.stop();
  });

  it('高风险的批准先验证本人，没通过不发请求；拒绝不用验证', async () => {
    const studio = new FakeHost('mobile-s');
    studio.items = [risky('apr_1'), risky('apr_2')];
    const source = new FakeSource();
    source.add('studio', studio);
    const store = new InboxStore(source);
    store.start();
    await settle();
    const gate = vi.fn(async () => false);
    offGate = setApprovalGate(gate);
    const [first, second] = store.snapshot.entries;
    if (first === undefined || second === undefined) throw new Error('no entries');
    await expect(store.respondApproval(first, 'allow-once')).rejects.toBeInstanceOf(
      ApprovalNotVerifiedError,
    );
    expect(studio.requests).toEqual([]);
    gate.mockResolvedValue(true);
    expect(await store.respondApproval(first, 'allow-once')).toEqual({ kind: 'done' });
    expect(await store.respondApproval(second, 'reject-once')).toEqual({ kind: 'done' });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(studio.requests.map((r) => r.params)).toEqual([
      { approvalId: 'apr_1', optionId: 'allow-once' },
      { approvalId: 'apr_2', optionId: 'reject-once' },
    ]);
    store.stop();
  });

  it('收起失败回合；电脑离线时不能作答', async () => {
    const studio = new FakeHost('mobile-s');
    studio.items = [failedItem('trn_1', '2026-10-27T09:00:00.000Z')];
    const source = new FakeSource();
    source.add('studio', studio);
    const store = new InboxStore(source);
    store.start();
    await settle();
    const [entry] = store.snapshot.entries;
    if (entry === undefined) throw new Error('no entry');
    await store.dismiss(entry);
    expect(studio.requests).toEqual([
      { method: 'inbox.dismiss', params: { itemId: 'turn_failed:trn_1' } },
    ]);
    expect(store.snapshot.entries).toEqual([]);
    source.add('studio', undefined);
    expect(store.snapshot.unavailable).toEqual(['STUDIO']);
    await expect(store.dismiss(entry)).rejects.toThrow(/not connected/);
    store.stop();
  });
});
