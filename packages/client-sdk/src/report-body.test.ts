import { describe, expect, it } from 'vitest';
import { reportBody } from './report-body.js';

describe('reportBody', () => {
  it('回报只显示那个会话的回答；没有回答时是错误；认不出的原样', () => {
    const tail = '\n\nRead the whole conversation with wevir_session_read if you need more.';
    expect(
      reportBody(
        `Session ses_ab "修复登录" finished a turn you asked for (completed).\nIts final answer:\n\n改好了。\n\n测试通过。${tail}`,
      ),
    ).toBe('改好了。\n\n测试通过。');
    expect(
      reportBody(
        `Session ses_ab finished a turn you asked for (failed).\nError: 额度用完\nIt gave no final answer.${tail}`,
      ),
    ).toBe('额度用完');
    expect(reportBody('别的文字')).toBe('别的文字');
  });

  it('几个会话合在一起的回报：每段前面写会话标题，去掉读全文的提示与会话状态', () => {
    const text =
      'Session ses_a "登录" finished a turn you asked for (completed).\nIts final answer:\n\n改好了。' +
      '\n\n---\n\n' +
      'Session ses_b finished a turn the user ran there (failed).\nError: 超时\nIt gave no final answer.' +
      '\n\nRead a whole conversation with wevir_session_read if you need more.' +
      '\n\nLinked sessions: "登录" = ses_a (idle), ses_b (error).';
    expect(reportBody(text)).toBe('**登录**\n\n改好了。\n\n---\n\n超时');
  });
});
