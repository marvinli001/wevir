import { generateKeyPairSync } from 'node:crypto';
import type { GatewayProvider } from '../types.js';

// 每次测试运行在内存生成，不把私钥或令牌录进样本。
export const vertexKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export function vertexAccount(kid = 'test-key'): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'agent@vertex-example.iam.gserviceaccount.com',
    private_key_id: kid,
    private_key: vertexKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

export function vertexProvider(api = 'openai-completions'): GatewayProvider {
  const model = api === 'anthropic-messages' ? 'claude-sonnet-5-5' : 'google/gemini-3.8-flash';
  return {
    id: api === 'anthropic-messages' ? 'vertex-claude' : 'vertex-gemini',
    kind: 'google-vertex',
    displayName: 'Vertex',
    api,
    vertex: { project: 'vertex-example', location: 'global' },
    models: [{ id: model }],
    defaultModelId: model,
    serviceAccountJson: vertexAccount(),
  };
}
