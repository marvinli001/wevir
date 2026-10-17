import { describe, expect, it } from 'vitest';
import { projectMenuGroups, sessionMenuGroups } from './context-menu-model';

describe('sessionMenuGroups', () => {
  it('Host 什么都支持时是完整的五组', () => {
    expect(sessionMenuGroups({ rename: true, branch: true, archive: true, delete: true })).toEqual([
      ['rename', 'pin', 'unread'],
      ['branch'],
      ['copy'],
      ['openWith'],
      ['archive', 'delete'],
    ]);
  });

  it('不能分支时没有“分支”那一组，也不留空的分隔', () => {
    expect(
      sessionMenuGroups({ rename: true, branch: false, archive: true, delete: true }).flat(),
    ).not.toContain('branch');
    expect(
      sessionMenuGroups({ rename: true, branch: false, archive: true, delete: true }),
    ).toHaveLength(4);
  });

  it('旧 Host（没有改名、归档、删除）：只剩置顶、未读、复制与打开方式', () => {
    expect(
      sessionMenuGroups({ rename: false, branch: false, archive: false, delete: false }),
    ).toEqual([['pin', 'unread'], ['copy'], ['openWith']]);
  });

  it('能归档但不能永久删除时，归档单独一项', () => {
    const groups = sessionMenuGroups({ rename: true, branch: false, archive: true, delete: false });
    expect(groups.at(-1)).toEqual(['archive']);
  });
});

describe('projectMenuGroups', () => {
  it('完整的四组', () => {
    expect(projectMenuGroups({ edit: true, archiveSessions: true })).toEqual([
      ['pin', 'edit'],
      ['reveal'],
      ['archiveSessions'],
      ['remove'],
    ]);
  });

  it('没有会话时不能“归档会话”；Host 没有 workspace.update 时没有“编辑”', () => {
    expect(projectMenuGroups({ edit: false, archiveSessions: false })).toEqual([
      ['pin'],
      ['reveal'],
      ['remove'],
    ]);
  });
});
