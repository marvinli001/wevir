// `@wevir/adapter-codex/testing`：给依赖本包做集成测试的包用（Host 与真实 codex-app-server 的端到端测试、桌面验收）。
// 只有本地脚本化的 Responses mock 模型与指向它的 Provider，经 Host 的 `provider.upsert` 登记即可，不需要 Key。
// 产品代码不引用这个入口。

export {
  defaultMockScript,
  MOCK_MODEL,
  MOCK_PATCH,
  MOCK_UPSTREAM_KEY,
  type MockModel,
  type MockReply,
  type MockRequestBody,
  type MockRequestRecord,
  type MockScript,
  type MockToolCall,
  type MockView,
  mockProvider,
  startMockModel,
  viewOf,
} from './test-fixtures/mock-model.js';
