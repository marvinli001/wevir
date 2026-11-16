// `thread/start` 与 `thread/resume` 的 `developerInstructions`：额外目录的说明、Host 补给的规则文件（0.68.0）与主动派子智能体的说明。

import { describe, expect, it } from 'vitest';
import { CODEX_RULE_FILES, threadDeveloperInstructions } from './codex-adapter.js';

const BASE = { cwd: '/w', providerId: 'p', modelId: 'm' };

describe('threadDeveloperInstructions', () => {
  it('两样都没有时不带；有哪样带哪样，额外目录在前', () => {
    expect(threadDeveloperInstructions(BASE)).toEqual({});
    expect(threadDeveloperInstructions({ ...BASE, ruleInstructions: '# Rules' })).toEqual({
      developerInstructions: '# Rules',
    });
    const both = threadDeveloperInstructions({
      ...BASE,
      additionalRoots: ['/other'],
      ruleInstructions: '# Rules',
    }).developerInstructions;
    expect(both).toMatch(/^Besides the working directory[\s\S]*- \/other\n\n# Rules$/);
  });

  it('主动派子智能体开着时接在最后，关着时不带', () => {
    const prompts = { proactiveSubagents: () => '## 主动派子智能体' };
    expect(threadDeveloperInstructions({ ...BASE, ruleInstructions: '# Rules' }, prompts)).toEqual({
      developerInstructions: '# Rules',
    });
    expect(
      threadDeveloperInstructions(
        { ...BASE, ruleInstructions: '# Rules', proactiveSubagents: true },
        prompts,
      ),
    ).toEqual({ developerInstructions: '# Rules\n\n## 主动派子智能体' });
  });

  it('Codex 只读项目里的 AGENTS.md，补给的进说明', () => {
    expect(CODEX_RULE_FILES).toEqual({
      user: [],
      project: ['agents'],
      imports: false,
      instructions: true,
    });
  });
});
