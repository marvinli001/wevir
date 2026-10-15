import { Bot } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  type ComposerCommand,
  nudge,
  searchCommands,
  searchItems,
  slashMenuState,
} from './composer-commands';
import { detectMentionTrigger, mentionText, replaceTextRange } from './composer-trigger';

const item = (id: string, label: string, detail?: string) => ({
  id,
  label,
  ...(detail !== undefined && { detail }),
  run: () => {},
});

const commands: ComposerCommand[] = [
  { name: 'model', label: '模型', icon: Bot, items: () => [item('a', 'GPT-6.1 Sol', 'OpenAI')] },
  { name: 'permissions', label: '权限', icon: Bot, items: () => [] },
  { name: 'new', label: '新建会话', icon: Bot, run: () => {} },
  { name: 'btw', label: '支线提问', icon: Bot, insert: '/btw ' },
  { name: 'init', label: '初始化', icon: Bot, run: () => {} },
];

describe('slashMenuState', () => {
  it('opens the command list for a leading slash', () => {
    expect(slashMenuState('/', 1, commands)).toEqual({
      level: 'commands',
      query: '',
      rangeStart: 0,
      rangeEnd: 1,
    });
    expect(slashMenuState('  /mo', 5, commands)).toMatchObject({ query: 'mo', rangeStart: 2 });
  });

  it('opens a command’s items after a space', () => {
    const state = slashMenuState('/model sol', 10, commands);
    expect(state?.level).toBe('items');
    expect(state?.command?.name).toBe('model');
    expect(state?.query).toBe('sol');
  });

  it('stays closed elsewhere', () => {
    expect(slashMenuState('fix /model', 10, commands)).toBeUndefined();
    expect(slashMenuState('/new now', 8, commands)).toBeUndefined();
    expect(slashMenuState('/mo', 1, commands)).toBeUndefined();
    expect(slashMenuState('/model\nnext', 11, commands)).toBeUndefined();
    expect(slashMenuState('/mo rest', 2, commands)).toBeUndefined();
  });
});

describe('search', () => {
  it('ranks names before labels and keeps the order for an empty query', () => {
    expect(searchCommands(commands, '').map((c) => c.name)).toEqual([
      'model',
      'permissions',
      'new',
      'btw',
      'init',
    ]);
    expect(searchCommands(commands, 'n')[0]?.name).toBe('new');
    expect(searchCommands(commands, '模型').map((c) => c.name)).toEqual(['model']);
    expect(searchCommands(commands, 'zzz')).toEqual([]);
  });

  it('searches items by label, id and detail', () => {
    const items = [item('x', 'Luna'), item('y', 'Sol', 'OpenAI'), item('z', 'Haiku', 'Claude')];
    expect(searchItems(items, 'sol').map((i) => i.id)).toEqual(['y']);
    expect(searchItems(items, 'claude').map((i) => i.id)).toEqual(['z']);
  });

  it('wraps the highlight', () => {
    expect(nudge(0, -1, 3)).toBe(2);
    expect(nudge(2, 1, 3)).toBe(0);
    expect(nudge(0, 1, 0)).toBe(0);
  });
});

describe('mentions', () => {
  it('detects @ at the cursor token', () => {
    expect(detectMentionTrigger('look at @src/co', 15)).toEqual({
      query: 'src/co',
      rangeStart: 8,
      rangeEnd: 15,
    });
    expect(detectMentionTrigger('mail a@b', 8)).toBeNull();
    expect(detectMentionTrigger('@', 1)).toEqual({ query: '', rangeStart: 0, rangeEnd: 1 });
  });

  it('replaces the token and quotes paths with spaces', () => {
    expect(replaceTextRange('see @co', 4, 7, '@src/composer.tsx ')).toEqual({
      text: 'see @src/composer.tsx ',
      cursor: 22,
    });
    expect(mentionText('a b/c.ts')).toBe('@`a b/c.ts`');
    expect(mentionText('src/a.ts')).toBe('@src/a.ts');
  });
});

describe('只在“+”菜单里的命令（0.36.0）', () => {
  const plusOnly: ComposerCommand = { name: 'plan', label: 'Plan mode', icon: Bot, slash: false };
  const exit: ComposerCommand = { name: 'default', label: 'Default mode', icon: Bot };
  it('斜杠菜单不列 slash: false 的命令，也不进它的二级菜单', () => {
    expect(searchCommands([plusOnly, exit], '').map((command) => command.name)).toEqual([
      'default',
    ]);
    expect(searchCommands([plusOnly, exit], 'plan')).toEqual([]);
    const nested = { ...plusOnly, items: () => [] };
    expect(slashMenuState('/plan x', 7, [nested])).toBeUndefined();
  });
});
