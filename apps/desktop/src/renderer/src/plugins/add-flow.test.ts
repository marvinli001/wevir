import type { Skill } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { inputValues, missingRequired, newlyInstalled, planAdd } from './add-flow';

describe('planAdd', () => {
  it('任何格式的插件、缺失或损坏的清单均先交 Host 预览', () => {
    for (const inspection of [
      { kind: 'plugin', format: 'wevir' },
      { kind: 'plugin', format: 'wevir', manifest: { id: 'bad id' } },
      { kind: 'plugin', format: 'claude' },
      { kind: 'plugin', format: 'codex' },
    ] as const)
      expect(planAdd(inspection, true)).toEqual({ action: 'preview' });
  });
  it('Skills 直接装，插件能力缺失与无效来源报错', () => {
    expect(planAdd({ kind: 'skill' }, false)).toEqual({ action: 'skill' });
    expect(planAdd({ kind: 'plugin', format: 'wevir' }, false)).toEqual({
      action: 'error',
      reason: 'packages',
    });
    expect(planAdd({ kind: 'unsupported' }, true)).toEqual({
      action: 'error',
      reason: 'unsupported',
    });
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
