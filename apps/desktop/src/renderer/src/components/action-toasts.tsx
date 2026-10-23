import { actionNotices, dismissActionNotice } from '@/data/action-notices';
import { Toast } from './toast';

/**
 * 动作结果的提示（data/action-notices.ts），挂在 ToastViewport 里；到点自动关闭（成功的 2 秒，失败的留久一点好读完），
 * 指针停在上面时暂停。
 */
const SUCCESS_MS = 2000;
const FAILURE_MS = 8000;

export function ActionToasts() {
  const notices = actionNotices.use();
  return notices.map((notice) => (
    <Toast
      key={notice.key}
      open={!notice.closing}
      tone={notice.tone}
      title={notice.text}
      duration={notice.tone === 'success' ? SUCCESS_MS : FAILURE_MS}
      testId={notice.tone === 'success' ? 'action-success' : 'action-failure'}
      onClose={() => dismissActionNotice(notice.key)}
    />
  ));
}
