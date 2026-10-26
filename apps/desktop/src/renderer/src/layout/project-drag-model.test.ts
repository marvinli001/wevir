import { describe, expect, it } from 'vitest';
import { moveProject, projectDropIndex, projectInsertIndex } from './project-drag-model';

describe('projectInsertIndex', () => {
  it('过了第 i 个标题的中线插在它后面', () => {
    const midlines = [116, 149, 300];
    expect(projectInsertIndex(50, midlines)).toBe(0);
    expect(projectInsertIndex(116, midlines)).toBe(0);
    expect(projectInsertIndex(117, midlines)).toBe(1);
    expect(projectInsertIndex(250, midlines)).toBe(2);
    expect(projectInsertIndex(900, midlines)).toBe(3);
    expect(projectInsertIndex(10, [])).toBe(0);
  });
});

describe('projectDropIndex', () => {
  const listed = ['p1', 'p2', 'a', 'b', 'c'];
  const pinned = ['p1', 'p2'];

  it('没置顶的不越到置顶的前面', () => {
    expect(projectDropIndex(listed, pinned, 'c', 0)).toBe(2);
    expect(projectDropIndex(listed, pinned, 'c', 3)).toBe(3);
    expect(projectDropIndex(listed, pinned, 'c', 9)).toBe(4);
  });

  it('置顶的只在置顶的之间', () => {
    expect(projectDropIndex(listed, pinned, 'p1', 4)).toBe(1);
    expect(projectDropIndex(listed, pinned, 'p2', -1)).toBe(0);
  });

  it('没有置顶时整列都能去', () => {
    expect(projectDropIndex(['a', 'b', 'c'], [], 'a', 2)).toBe(2);
    expect(projectDropIndex(['a', 'b', 'c'], [], 'c', 0)).toBe(0);
  });
});

describe('moveProject', () => {
  it('挪到去掉它之后的位置', () => {
    expect(moveProject(['a', 'b', 'c', 'd'], [], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveProject(['a', 'b', 'c', 'd'], [], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('上移、下移：位置 ±1，到了那一段的头或尾时不变', () => {
    const listed = ['p1', 'a', 'b'];
    const pinned = ['p1'];
    expect(moveProject(listed, pinned, 'b', 0)).toEqual(['p1', 'b', 'a']);
    expect(moveProject(listed, pinned, 'a', 0)).toBe(listed);
    expect(moveProject(listed, pinned, 'b', 3)).toBe(listed);
    expect(moveProject(listed, pinned, 'p1', 1)).toBe(listed);
  });

  it('顺序没变或项目不在列表里时返回原数组', () => {
    const listed = ['a', 'b'];
    expect(moveProject(listed, [], 'a', 0)).toBe(listed);
    expect(moveProject(listed, [], 'gone', 0)).toBe(listed);
  });
});
