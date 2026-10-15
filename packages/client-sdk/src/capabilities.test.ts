import { describe, expect, it } from 'vitest';
import { commandSupported, goalsSupported, planModeSupported } from './capabilities.js';

describe('commandSupported（0.27.0）', () => {
  const features = { session_compact: true, session_review: true };

  it('按会话当前引擎的 commands', () => {
    const claude = { engine: 'claude', commands: ['compact' as const] };
    expect(commandSupported(features, claude, 'compact')).toBe(true);
    expect(commandSupported(features, claude, 'review')).toBe(false);
    expect(commandSupported(features, { engine: 'cursor', commands: [] }, 'compact')).toBe(false);
  });

  it('Host 没声明功能时不能用', () => {
    const codex = { engine: 'codex', commands: ['compact' as const, 'review' as const] };
    expect(commandSupported({ session_compact: true }, codex, 'review')).toBe(false);
  });

  it('更早的 Host 没有 commands 或 engineFeatures：只看功能', () => {
    expect(commandSupported(features, { engine: 'echo' }, 'review')).toBe(true);
    expect(commandSupported(features, undefined, 'compact')).toBe(true);
    expect(commandSupported({}, undefined, 'compact')).toBe(false);
  });
});

describe('goalsSupported（0.35.0）', () => {
  it('要 Host 声明 session_goals，且会话当前的引擎有目标', () => {
    const codex = { engine: 'codex', commands: [], goals: true };
    const claude = { engine: 'claude', commands: [] };
    expect(goalsSupported({ session_goals: true }, codex)).toBe(true);
    expect(goalsSupported({ session_goals: true }, claude)).toBe(false);
    expect(goalsSupported({}, codex)).toBe(false);
    expect(goalsSupported({ session_goals: true }, undefined)).toBe(false);
  });
});

describe('planModeSupported（0.36.0）', () => {
  it('Host 声明 plan_mode，且会话当前的引擎有计划模式', () => {
    const codex = { engine: 'codex', planMode: true };
    expect(planModeSupported({ plan_mode: true }, codex)).toBe(true);
    expect(planModeSupported({ plan_mode: true }, { engine: 'cursor' })).toBe(false);
    expect(planModeSupported({}, codex)).toBe(false);
    expect(planModeSupported({ plan_mode: true }, undefined)).toBe(false);
  });
});
