import { describe, expect, it } from 'vitest';
import {
  collapsedPlanPreview,
  planCollapsible,
  planFileContents,
  planFilename,
  planFollowUpSubmission,
  planImplementationPrompt,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from './proposed-plan';

const PLAN = [
  '# 加一个导出按钮',
  '',
  '## Summary',
  '',
  '工具栏加“导出”。',
  '',
  '## 测试',
  '',
  '- 空列表',
].join('\n');

describe('计划卡片的纯逻辑（0.36.0）', () => {
  it('标题取第一个 Markdown 标题；正文去掉标题与紧跟的 Summary', () => {
    expect(proposedPlanTitle(PLAN)).toBe('加一个导出按钮');
    expect(proposedPlanTitle('没有标题')).toBeNull();
    expect(stripDisplayedPlanMarkdown(PLAN)).toBe('工具栏加“导出”。\n\n## 测试\n\n- 空列表');
  });

  it('长计划折叠：超过 20 行或 900 字；预览是前几行有内容的行加 ...', () => {
    const long = ['# T', ...Array.from({ length: 30 }, (_, i) => `- 第 ${i + 1} 步`)].join('\n');
    expect(planCollapsible(PLAN)).toBe(false);
    expect(planCollapsible(long)).toBe(true);
    const preview = collapsedPlanPreview(long, 3);
    expect(preview).toBe('- 第 1 步\n- 第 2 步\n- 第 3 步\n\n...');
  });

  it('计划之后按发送：有字是继续完善（计划模式），空着是实施（默认模式）', () => {
    expect(
      planFollowUpSubmission({ draftText: '  再加个筛选 ', planMarkdown: PLAN, prefix: 'P:' }),
    ).toEqual({
      text: '再加个筛选',
      collaborationMode: 'plan',
    });
    expect(
      planFollowUpSubmission({ draftText: '', planMarkdown: `${PLAN}\n\n`, prefix: 'P:' }),
    ).toEqual({
      text: planImplementationPrompt('P:', PLAN),
      collaborationMode: 'default',
    });
    expect(planImplementationPrompt('请按这个计划实施：', ' # A \n')).toBe(
      '请按这个计划实施：\n# A',
    );
  });

  it('下载的文件名保留汉字，去掉不能用的字符；内容以一个换行结尾', () => {
    expect(planFilename(PLAN)).toBe('加一个导出按钮.md');
    expect(planFilename('# Fix: the "login" bug / 500?')).toBe('fix-the-login-bug-500.md');
    expect(planFilename('no heading')).toBe('plan.md');
    expect(planFileContents('# A\n\n\n')).toBe('# A\n');
  });
});
