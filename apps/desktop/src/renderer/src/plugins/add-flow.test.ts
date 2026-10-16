import { WevirRpcError } from '@wevir/client-sdk';
import type { Plugin, Skill } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  inputValues,
  isAlreadyInstalled,
  missingRequired,
  newlyInstalled,
  planAdd,
} from './add-flow';

const installed = (id: string): Plugin => ({
  id,
  name: id,
  version: '1.0.0',
  source: 'wevir',
  enabled: true,
  path: `/data/plugins/packages/${id}`,
  inputs: [],
  connectors: [],
  skills: [],
});
const manifest = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'sample',
  name: 'Sample',
  version: '1.1.0',
  ...patch,
});
const wevir = (value: unknown) => ({ kind: 'plugin', format: 'wevir', manifest: value }) as const;

describe('planAdd', () => {
  it('Skills 直接装，不是来源的报错', () => {
    expect(planAdd({ kind: 'skill' }, [], true)).toEqual({ action: 'skill' });
    // Host 没有插件包时 Skills 照样能装。
    expect(planAdd({ kind: 'skill' }, [], false)).toEqual({ action: 'skill' });
    expect(planAdd({ kind: 'unsupported' }, [], true)).toEqual({
      action: 'error',
      reason: 'unsupported',
    });
  });

  it('Host 没有插件包功能时插件包装不了', () => {
    expect(planAdd(wevir(manifest()), [], false)).toEqual({ action: 'error', reason: 'packages' });
    expect(planAdd({ kind: 'plugin', format: 'claude' }, [], false)).toEqual({
      action: 'error',
      reason: 'packages',
    });
  });

  it('新的 Wevir 包：有输入项先填，没有直接装', () => {
    expect(planAdd(wevir(manifest()), [], true)).toEqual({ action: 'plugin' });
    expect(planAdd(wevir(manifest({ inputs: [] })), [], true)).toEqual({ action: 'plugin' });
    const inputs = [{ key: 'TOKEN', label: 'Token', secret: true, required: true }];
    const plan = planAdd(wevir(manifest({ inputs })), [installed('other')], true);
    expect(plan).toMatchObject({ action: 'inputs', manifest: { id: 'sample', inputs } });
  });

  it('清单的 id 已装过：问升级（不再问输入项）', () => {
    const inputs = [{ key: 'TOKEN', label: 'Token', required: true }];
    const existing = installed('sample');
    const plan = planAdd(wevir(manifest({ inputs })), [existing], true);
    expect(plan).toMatchObject({ action: 'upgrade', installed: existing });
  });

  it('清单读不出或校验不过时直接交给 Host，它的原因显示在对话框里', () => {
    expect(planAdd({ kind: 'plugin', format: 'wevir' }, [], true)).toEqual({ action: 'plugin' });
    expect(planAdd(wevir({ nope: true }), [], true)).toEqual({ action: 'plugin' });
    expect(planAdd(wevir(manifest({ id: 'Bad Id' })), [], true)).toEqual({ action: 'plugin' });
  });

  it('Claude / Codex 的包没有可读的清单，直接装', () => {
    expect(planAdd({ kind: 'plugin', format: 'claude' }, [installed('x')], true)).toEqual({
      action: 'plugin',
    });
    expect(planAdd({ kind: 'plugin', format: 'codex' }, [], true)).toEqual({ action: 'plugin' });
  });
});

describe('isAlreadyInstalled', () => {
  const rpc = (code: number, message: string) =>
    new WevirRpcError('plugin.install', { code, message });

  it('认 Host 的“同 id 已装”（INVALID_PARAMS）', () => {
    expect(
      isAlreadyInstalled(
        rpc(-32602, 'Plugin "sample" is already installed; pass replace to upgrade it'),
      ),
    ).toBe(true);
    expect(isAlreadyInstalled(rpc(-32602, 'Skill "x" conflicts with an installed skill'))).toBe(
      false,
    );
    expect(isAlreadyInstalled(rpc(-32603, 'Plugin "sample" is already installed'))).toBe(false);
    expect(isAlreadyInstalled(new Error('already installed'))).toBe(false);
    expect(isAlreadyInstalled(undefined)).toBe(false);
  });
});

describe('输入项', () => {
  const target = {
    inputs: [
      { key: 'TOKEN', label: 'Token', required: true, secret: true },
      { key: 'REGION', label: 'Region' },
      { key: 'ORG', label: 'Org', required: true },
    ],
  };

  it('必填项没填（去掉空白后为空）就列出来', () => {
    expect(missingRequired(target, {})).toEqual(['TOKEN', 'ORG']);
    expect(missingRequired(target, { TOKEN: 'x', ORG: '  ' })).toEqual(['ORG']);
    expect(missingRequired(target, { TOKEN: 'x', ORG: 'y' })).toEqual([]);
    expect(missingRequired({}, {})).toEqual([]);
  });

  it('交给 plugin.install 的只有填了的', () => {
    expect(inputValues({ TOKEN: 'x', REGION: '', ORG: '  ' })).toEqual({ TOKEN: 'x' });
  });
});

describe('其他', () => {
  it('skill.install 回的是全部，这次新装的是新出现的那些', () => {
    const skill = (id: string): Skill => ({
      id,
      name: id,
      description: 'd',
      source: 'wevir',
      path: `/p/${id}/SKILL.md`,
      enabled: true,
    });
    expect(
      newlyInstalled([skill('a')], [skill('a'), skill('b'), skill('c')]).map((s) => s.id),
    ).toEqual(['b', 'c']);
    expect(newlyInstalled([], [])).toEqual([]);
  });
});
