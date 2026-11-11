// 本机脚本化上游，供真实引擎的集成测试使用；产品代码不引用此入口。
export { startMockChat } from './test-fixtures/mock-chat.js';
export { startMockMessages } from './test-fixtures/mock-messages.js';
export type { Script } from './test-fixtures/model-script.js';
