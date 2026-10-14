// `@wevir/adapter-codex/testing`：给依赖本包做集成测试的包用（Host 与真实 codex-app-server 的端到端测试、桌面验收）。
// 本地脚本化的 Responses mock 模型与指向它的 Provider（经 Host 的 `provider.upsert` 登记即可，不需要 Key），以及 ChatGPT
// 登录服务与后端的 mock（R6，交给 `CodexRuntime` 的 `chatgptEndpoints`，不需要真实账号）。产品代码不引用这个入口。

export {
  MOCK_CHATGPT_EMAIL,
  MOCK_CHATGPT_MODEL,
  MOCK_CHATGPT_PLAN,
  MOCK_USER_CODE,
  type MockChatgpt,
  type MockChatgptRequest,
  startMockChatgpt,
} from './test-fixtures/mock-chatgpt.js';
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
