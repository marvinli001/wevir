import { CSPProvider } from '@base-ui/react/csp-provider';
import { RouterProvider } from 'react-router/dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkbenchDataProvider } from '@/data/workbench-data';
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
          </TooltipProvider>
        </WorkbenchDataProvider>
      </HostConnectionProvider>
    </CSPProvider>
  );
}
