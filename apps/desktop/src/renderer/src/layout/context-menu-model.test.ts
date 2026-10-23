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

  it('能移动时“移到工作树 / 移回本地”跟在分支后面（0.81.0）', () => {
    expect(
      sessionMenuGroups({ rename: true, branch: true, move: true, archive: true, delete: true })[1],
    ).toEqual(['branch', 'move']);
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

  it('路径不在这台电脑上时没有“在访达中显示”，没有 workspace.write 时没有“移除项目”', () => {
    expect(
      projectMenuGroups({ edit: false, archiveSessions: true, reveal: false, remove: false }),
    ).toEqual([['pin'], ['archiveSessions']]);
  });
});

describe('会话菜单的“打开方式”', () => {
  it('路径不在这台电脑上时整组省掉', () => {
    expect(
      sessionMenuGroups({
        rename: true,
        branch: false,
        archive: true,
        delete: true,
        openWith: false,
      }).flat(),
    ).not.toContain('openWith');
  });
});
