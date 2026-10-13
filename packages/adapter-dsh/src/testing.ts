// `@wevir/adapter-dsh/testing`：给依赖本包做集成测试的包用（Host 与真实 dsh 的端到端测试）。只有本地脚本化的
// OpenAI 兼容 mock Provider，经 Host 的 `provider.upsert` 登记即可，不需要 Key，也不需要知道 dsh 的配置格式。
// 产品代码不引用这个入口。

export {
  MOCK_MODEL,
  type MockModel,
  type MockReply,
  type MockRequest,
  type MockRequestMeta,
  startMockModel,
  textOf,
} from './test-fixtures/mock-model.js';
