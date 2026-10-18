import { CSPProvider } from '@base-ui/react/csp-provider';
import { RouterProvider } from 'react-router/dom';
import { BrowserCoordinator } from '@/browser/browser-coordinator';
import { ActionToasts } from '@/components/action-toasts';
import { ToastViewport } from '@/components/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PreventSleepCoordinator } from '@/data/prevent-sleep';
import { WorkbenchDataProvider } from '@/data/workbench-data';
import { ConnectionToast } from '@/host/connection-toast';
import { HostConnectionProvider } from '@/host/host-connection';
import { SplashGate } from '@/layout/splash';
import { NotificationCoordinator } from '@/notifications/notification-coordinator';
import { router } from '@/routes/router';

export function App() {
  return (
    // CSP 不放行内联 <style>（src/shared/csp.ts）：Base UI 不再自己插样式标签，它需要的规则在 index.css。
    <CSPProvider disableStyleElements>
      <HostConnectionProvider>
        <WorkbenchDataProvider>
          {/* 启动画面：数据就绪后撤掉（layout/splash.tsx）。 */}
          <SplashGate />
          <TooltipProvider delay={500}>
            <RouterProvider router={router} />
            {/* 内置浏览器（0.33.0）：登记为浏览器提供方，转交 agent 的浏览器命令。 */}
            <BrowserCoordinator />
            <PreventSleepCoordinator />
            {/* 连接通知在窗口右下角，工作台与设置页都看得到（T5.5，U25）。 */}
            <ToastViewport>
              <ConnectionToast />
              {/* 菜单动作的失败提示（归档、分支、删除…）。 */}
              <ActionToasts />
              {/* 会话的通知（U31）：系统通知与应用内提醒。 */}
              <NotificationCoordinator />
            </ToastViewport>
          </TooltipProvider>
        </WorkbenchDataProvider>
      </HostConnectionProvider>
    </CSPProvider>
  );
}
