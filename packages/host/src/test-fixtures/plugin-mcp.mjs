// plugins.codex.integration.test.ts 的本机 stdio MCP 服务，无外连、无依赖。
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
        serverInfo: { name: 'wevir-plugin-test', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'plugin_ping',
            description: 'Call the local test plugin',
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
              process.env.PLUGIN_TEST_SECRET === 'plugin-env-not-a-real-secret'
                ? 'PLUGIN-TOOL-CALLED'
                : 'PLUGIN-ENV-MISSING',
          },
        ],
      };
      break;
    default:
      result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
