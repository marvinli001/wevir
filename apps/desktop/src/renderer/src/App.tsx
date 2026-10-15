import { CSPProvider } from '@base-ui/react/csp-provider';
import { RouterProvider } from 'react-router/dom';
import { ToastViewport } from '@/components/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkbenchDataProvider } from '@/data/workbench-data';
import { ConnectionToast } from '@/host/connection-toast';
import { HostConnectionProvider } from '@/host/host-connection';
import { router } from '@/routes/router';

export function App() {
  return (
    // CSP 不放行内联 <style>（src/shared/csp.ts）：Base UI 不再自己插样式标签，它需要的规则在 index.css。
    <CSPProvider disableStyleElements>
      <HostConnectionProvider>
        <WorkbenchDataProvider>
          <TooltipProvider delay={500}>
            <RouterProvider router={router} />
            {/* 连接通知在窗口右下角，工作台与设置页都看得到（T5.5，U25）。 */}
            <ToastViewport>
              <ConnectionToast />
            </ToastViewport>
          </TooltipProvider>
        </WorkbenchDataProvider>
      </HostConnectionProvider>
    </CSPProvider>
  );
}
