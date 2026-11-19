import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startModelGateway } from '@wevir/model-gateway';
import type { SecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../sync/crypto.js';
import { ZuvAccounts } from './accounts.js';
import { ZuvClient } from './client.js';
import { zuvGatewayAuth } from './gateway-auth.js';
import { newZuvDeviceKey } from './transport.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('ZUV through the existing model gateway', () => {
  it('signs translated bytes and isolates subscription credentials from other providers', async () => {
    const key = newZuvDeviceKey();
    const token = 'synthetic-ZUV-access-token';
    const calls: Array<{ path: string; body: Buffer; authorization?: string; dpop?: string }> = [];
    let denied = false;
    let echoToken = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      calls.push({
        path: req.url as string,
        body,
        authorization: req.headers.authorization,
        dpop: req.headers.dpop as string | undefined,
      });
      if (req.url === '/api/wevir/refresh') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'AUTH_REQUIRED' } }));
        return;
      }
      if (req.url === '/api/wevir/v1/responses') {
        expect(req.headers.authorization).toBe(`DPoP ${token}`);
        expect(req.headers['content-encoding']).toBeUndefined();
        expect(req.headers['content-length']).toBe(String(body.length));
        const [head, payload, signature] = String(req.headers.dpop).split('.') as [
          string,
          string,
          string,
        ];
        expect(
          verify(
            null,
            Buffer.from(`${head}.${payload}`),
            createPublicKey({ key: key.publicKey, format: 'jwk' }),
            Buffer.from(signature, 'base64url'),
          ),
        ).toBe(true);
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
          bht: sha256(body),
          ath: sha256(token),
          htu: `${origin}/api/wevir/v1/responses`,
        });
        expect(JSON.parse(body.toString()).client_metadata).toBeUndefined();
      } else {
        expect(req.headers.authorization).toBe('Bearer synthetic-other-provider-key');
        expect(req.headers.dpop).toBeUndefined();
      }
      if (denied) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: token } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (echoToken) {
          for (const delta of [token.slice(0, 12), token.slice(12)])
            res.write(
              `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'message_fixture', content_index: 0, output_index: 0, delta })}\n\n`,
            );
          res.write(
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'message_fixture', content_index: 0, output_index: 0, text: token })}\n\n`,
          );
        }
        res.end(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response_fixture","status":"completed","output":[]}}\n\n',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const values = new Map<string, string>([
      [
        'zuv.identity',
        JSON.stringify({
          v: 1,
          origin,
          key,
          deviceId: 'device_fixture',
          tokens: {
            accessToken: token,
            refreshToken: 'synthetic-refresh-token',
            expiresAt: Date.now() + 900000,
          },
          entitlements: {
            protocol: 'wevir-sync/1',
            vault: null,
            identity: { userId: 'user_fixture', deviceId: 'device_fixture' },
            deviceScopes: ['identity', 'inference', 'sync', 'recovery'],
            subscriptionState: 'active',
            syncState: 'disabled',
            quota: {},
            retentionUntil: null,
            recovery: { eligible: false, requiresApproval: false },
            limits: {},
          },
        }),
      ],
    ]);
    const secrets: SecretStore = {
      get: async (name) => values.get(name),
      set: async (name, value) => {
        values.set(name, value);
      },
      delete: async (name) => values.delete(name),
    };
    const client = new ZuvClient({ origin, allowLoopback: true, secrets });
    await client.load();
    const accounts = new ZuvAccounts(client);
    cleanups.push(() => accounts.close());
    const states: unknown[] = [];
    accounts.onChange((state) => states.push(state));
    const logs: unknown[] = [];
    const gateway = await startModelGateway({
      auth: zuvGatewayAuth(client),
      logger: {
        info: (message, fields) => logs.push({ message, fields }),
        warn: (message, fields) => logs.push({ message, fields }),
      },
    });
    cleanups.push(() => gateway.close());
    gateway.setProviders([
      {
        id: 'zuv',
        kind: 'zuv',
        displayName: 'ZUV',
        models: [{ id: 'synthetic-model' }],
        defaultModelId: 'synthetic-model',
        compat: { requestCompression: 'gzip' },
      },
      {
        id: 'other',
        kind: 'openai-compatible',
        displayName: 'Other',
        api: 'openai-responses',
        baseURL: `${origin}/other/v1`,
        apiKey: 'synthetic-other-provider-key',
        models: [{ id: 'synthetic-model' }],
        defaultModelId: 'synthetic-model',
      },
    ]);
    const body = JSON.stringify({
      model: 'synthetic-model',
      reasoning: { effort: 'high' },
      input: 'synthetic '.repeat(1000),
      stream: true,
      client_metadata: { localId: 'never forwarded' },
    });
    const send = (id: string) =>
      fetch(`${gateway.baseURL(id)}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body,
      });
    const response = await send('zuv');
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(calls.map((call) => JSON.parse(call.body.toString()).reasoning)).toEqual([
      { effort: 'high' },
    ]);
    const other = await send('other');
    expect(other.status).toBe(200);
    await other.text();
    expect(calls).toHaveLength(2);
    const tested = await gateway.testProvider(
      {
        id: 'zuv',
        kind: 'zuv',
        displayName: 'ZUV',
        models: [{ id: 'synthetic-model' }],
        defaultModelId: 'synthetic-model',
      },
      'synthetic-model',
    );
    expect(tested).toMatchObject({ ok: true });
    echoToken = true;
    const reflected = await send('zuv');
    expect(reflected.status).toBe(200);
    const reflectedText = await reflected.text();
    expect(reflectedText).not.toContain(token);
    expect(reflectedText).not.toContain(token.slice(0, 12));
    echoToken = false;
    denied = true;
    const error = await send('zuv');
    expect(error.status).toBe(401);
    expect(states.at(-1)).toMatchObject({ zuv: { connection: 'reauthorization_required' } });
    expect(await error.text()).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
    await client.logout();
    const unauthorized = await send('zuv');
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();
    expect(calls).toHaveLength(6);
  });
});
