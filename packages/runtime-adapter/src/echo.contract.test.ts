import { type AdapterCapabilities, runAdapterContract } from './contract.js';
import { EchoAdapter } from './echo.js';

const ALL_CAPABILITIES: AdapterCapabilities = {
  incrementalStream: true,
  toolCalls: true,
  approvals: true,
  resume: true,
  concurrentSessions: true,
  subagents: true,
};

const hooks = {
  simulateEngineExit: (adapter: EchoAdapter) => adapter.simulateEngineExit(),
  resourcesReleased: (adapter: EchoAdapter) =>
    adapter.pendingTimerCount === 0 && adapter.sessionCount === 0,
};

runAdapterContract(() => new EchoAdapter(), ALL_CAPABILITIES, {
  name: 'EchoAdapter 契约（全部能力）',
  ...hooks,
});

// 模拟 stream-tap 旁路缺失：增量条款按开关跳过，其余条款照跑。
runAdapterContract(
  () => new EchoAdapter({ incrementalStream: false }),
  { ...ALL_CAPABILITIES, incrementalStream: false },
  { name: 'EchoAdapter 契约（无增量）', ...hooks },
);
