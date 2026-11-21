import { describe, expect, it, vi } from 'vitest';
import {
  applyKiroAutopilot,
  applyKiroEffort,
  applyKiroMode,
  kiroAllowsUnattended,
  kiroEffortValue,
} from './config.js';
import { kiroModels, parseKiroModelList } from './models.js';

function select(id: string, currentValue: string, values: string[]) {
  return { type: 'select', id, currentValue, options: values.map((value) => ({ value })) };
}

function sessionConfig(initial: ReturnType<typeof select>[], updates = [initial]) {
  let options = initial;
  return {
    read: () => options,
    waitFor: vi.fn(async (predicate: (value: unknown) => boolean) => {
      for (const update of updates) {
        options = update;
        if (predicate(update)) return update;
      }
      return undefined;
    }),
    set: vi.fn(async (id: string, currentValue: string) => {
      options = options.map((option) => (option.id === id ? { ...option, currentValue } : option));
    }),
  };
}

describe('Kiro V3 session choices', () => {
  it('waits for effort options belonging to the selected model and maps off to none', async () => {
    const old = [select('model', 'old', ['old', 'new']), select('effortLevel', 'high', ['high'])];
    const switching = [select('model', 'new', ['old', 'new'])];
    const ready = [...switching, select('effortLevel', 'high', ['none', 'high'])];
    const access = sessionConfig(old, [old, switching, ready]);

    await applyKiroEffort(access, 'new', 'off');

    expect(access.waitFor).toHaveBeenCalledTimes(1);
    expect(access.set.mock.calls).toEqual([['effortLevel', 'none']]);
    expect(kiroEffortValue(access.read())).toBe('off');
  });

  it('keeps the current effort when the selected model does not offer the requested level', async () => {
    const options = [select('model', 'new', ['new']), select('effortLevel', 'high', ['high'])];
    const access = sessionConfig(options);
    await applyKiroEffort(access, 'new', 'max');
    await applyKiroEffort(access, 'different', 'high');
    expect(access.set).not.toHaveBeenCalled();
  });

  it('restores the previous agent on the next default turn', async () => {
    const access = sessionConfig([select('mode', 'custom', ['vibe', 'custom', 'plan'])]);
    const beforePlan = await applyKiroMode(access, 'plan');
    expect(beforePlan).toBe('custom');
    expect(await applyKiroMode(access, 'plan', beforePlan)).toBe('custom');
    expect(await applyKiroMode(access, undefined, beforePlan)).toBeUndefined();
    expect(access.set.mock.calls).toEqual([
      ['mode', 'plan'],
      ['mode', 'custom'],
    ]);
  });

  it('uses the advertised default when restoring a planner without a remembered agent', async () => {
    const access = sessionConfig([
      select('mode', 'kiro_planner', ['kiro_default', 'kiro_planner']),
    ]);
    await applyKiroMode(access, 'default');
    expect(access.set.mock.calls).toEqual([['mode', 'kiro_default']]);
  });

  it('checks that supervised mode is active before sending a protected prompt', async () => {
    const access = sessionConfig([select('autopilot', 'on', ['off', 'on'])]);
    const fullAccess = { permissionMode: 'full_access' } as const;
    const restricted = {
      ...fullAccess,
      engineTools: { denied: [], deniedNames: [], allowedNames: ['read'] },
    };

    expect(kiroAllowsUnattended(fullAccess)).toBe(true);
    expect(kiroAllowsUnattended(fullAccess, 'plan')).toBe(false);
    expect(kiroAllowsUnattended(restricted)).toBe(false);
    await applyKiroAutopilot(access, fullAccess, 'plan');
    await applyKiroAutopilot(access, fullAccess);
    await applyKiroAutopilot(access, restricted);
    expect(access.set.mock.calls).toEqual([
      ['autopilot', 'off'],
      ['autopilot', 'on'],
      ['autopilot', 'off'],
    ]);

    const unconfirmed = sessionConfig([select('autopilot', 'on', ['off', 'on'])]);
    unconfirmed.set.mockImplementationOnce(async () => {});
    await expect(
      applyKiroAutopilot(unconfirmed, { permissionMode: 'on_request' }),
    ).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
  });
});

describe('Kiro V3 model catalog', () => {
  it('uses live effort choices for the active model and retains earlier discoveries', () => {
    const catalog = parseKiroModelList(
      '{"models":[{"model_id":"gpt-5.6-sol"},{"model_id":"claude-opus-4.6"}]}',
      true,
    );
    expect(catalog?.models[0]).toMatchObject({
      defaultReasoningEffort: 'high',
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    const models = ['gpt-5.6-sol', 'claude-opus-4.6'];
    const learned = kiroModels(
      [select('model', 'gpt-5.6-sol', models), select('effortLevel', 'none', ['none', 'high'])],
      undefined,
      catalog,
    );
    expect(learned?.models[0]?.reasoningEfforts).toEqual(['off', 'high']);
    const switched = kiroModels(
      [select('model', 'claude-opus-4.6', models), select('effortLevel', 'max', ['high', 'max'])],
      undefined,
      learned,
    );
    expect(switched?.models.map((model) => model.reasoningEfforts)).toEqual([
      ['off', 'high'],
      ['high', 'max'],
    ]);
  });
});
