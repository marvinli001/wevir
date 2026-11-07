import { beforeEach, expect, it, vi } from 'vitest';
import { highlightCodeBlocks } from './highlight';

const highlight = vi.hoisted(() => vi.fn((text: string) => ({ value: `<span>${text}</span>` })));
vi.mock('highlight.js/lib/common', () => ({
  default: { getLanguage: (name: string) => name === 'javascript', highlight },
}));
beforeEach(() => highlight.mockClear());

function block(text: string) {
  const attributes = new Set<string>();
  return {
    textContent: text,
    className: 'language-javascript',
    isConnected: true,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string) => attributes.add(name),
    innerHTML: '',
    classList: { add: vi.fn() },
  };
}
const root = (...blocks: ReturnType<typeof block>[]) =>
  ({ querySelectorAll: () => blocks }) as unknown as HTMLElement;

it('只高亮不超过 20000 字符的已知语言，离开的代码块不处理', async () => {
  const limit = block('a'.repeat(20_000));
  const large = block('b'.repeat(20_001));
  const detached = { ...block('detached'), isConnected: false };
  const unknown = { ...block('unknown'), className: 'language-unknown' };
  await highlightCodeBlocks(root(limit, large, detached, unknown));
  expect(highlight).toHaveBeenCalledTimes(1);
  expect(large.innerHTML).toBe('');
  expect(detached.hasAttribute('data-highlighted')).toBe(false);
});

it('代码块之间允许输入任务先运行', async () => {
  await highlightCodeBlocks(root(block('warm')));
  const order: string[] = [];
  highlight.mockImplementation((text) => {
    order.push(text);
    return { value: text };
  });
  const done = highlightCodeBlocks(root(block('first'), block('second')));
  const input = new Promise<void>((resolve) =>
    setTimeout(() => {
      order.push('input');
      resolve();
    }, 0),
  );
  await Promise.all([done, input]);
  expect(order).toEqual(['first', 'input', 'second']);
});
