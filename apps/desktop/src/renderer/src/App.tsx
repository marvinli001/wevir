import { CSPProvider } from '@base-ui/react/csp-provider';
import { RouterProvider } from 'react-router/dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkbenchDataProvider } from '@/data/workbench-data';
import { ConnectionBanner } from '@/host/connection-banner';
import { HostConnectionProvider } from '@/host/host-connection';
import { router } from '@/routes/router';

export function App() {
  return (
    // CSP 不放行内联 <style>（src/shared/csp.ts）：Base UI 不再自己插样式标签，它需要的规则在 index.css。
    <CSPProvider disableStyleElements>
      <HostConnectionProvider>
        <WorkbenchDataProvider>
          <TooltipProvider delay={500}>
            {/* 连接提示在最上方，工作台与设置页都看得到（T5.5）。 */}
            <div className="flex h-full flex-col">
              <ConnectionBanner />
              <div className="min-h-0 flex-1">
                <RouterProvider router={router} />
              </div>
            </div>
          </TooltipProvider>
        </WorkbenchDataProvider>
      </HostConnectionProvider>
    </CSPProvider>
  );
}
