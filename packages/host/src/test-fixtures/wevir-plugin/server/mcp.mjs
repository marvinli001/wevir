// test-fixtures/wevir-plugin 的 stdio MCP 服务：参数是 ${input:REGION}，环境变量 PACKAGE_TOKEN 是 ${input:TOKEN}。无外连、无依赖。
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'wevir-package-test', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'package_ping',
            description: 'Call the test plugin package',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: false },
          },
        ],
      };
      break;
    case 'tools/call':
      result = {
        content: [
          {
            type: 'text',
            text:
              process.env.PACKAGE_TOKEN === 'package-token-not-a-secret'
                ? `PACKAGE-TOOL-CALLED region=${process.argv[2]}`
                : 'PACKAGE-TOKEN-MISSING',
          },
        ],
      };
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
