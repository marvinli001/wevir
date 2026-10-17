import { actionNotices, dismissActionNotice } from '@/data/action-notices';
import { Toast } from './toast';

/** 动作失败的提示（data/action-notices.ts），挂在 ToastViewport 里；几秒后自动关闭，指针停在上面时暂停。 */
const NOTICE_MS = 8000;

export function ActionToasts() {
  const notices = actionNotices.use();
  return notices.map((notice) => (
    <Toast
      key={notice.key}
      open
      tone="danger"
      title={notice.text}
      duration={NOTICE_MS}
      testId="action-failure"
      onClose={() => dismissActionNotice(notice.key)}
    />
  ));
}
