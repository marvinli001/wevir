import { type MethodResult, type ProviderApi, ProviderModelSchema } from '@wevir/protocol';

const CATALOG_URL = 'https://zuv.wevir.si/api/public/models';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PROTOCOLS: Record<string, ProviderApi> = {
  responses: 'openai-responses',
  chat: 'openai-completions',
  messages: 'anthropic-messages',
  gemini: 'google-gemini',
};

export function isZuvApiBaseURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return (
      url.origin === 'https://zuv.wevir.si' &&
      /^\/v1\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function discoverZuvModels(
  modelId?: string,
  doFetch: typeof fetch = fetch,
): Promise<MethodResult<'provider.discoverModels'>> {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await doFetch(CATALOG_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, models: [], reason: response.status === 429 ? 'rate_limited' : 'server' };
    }
    if (!response.body) return { ok: false, models: [], reason: 'protocol' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return { ok: false, models: [], reason: 'protocol' };
      chunks.push(chunk);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, models: [], reason: 'protocol' };
    }
    if (!isObject(payload) || !Array.isArray(payload.data))
      return { ok: false, models: [], reason: 'protocol' };
    const models: MethodResult<'provider.discoverModels'>['models'] = [];
    const seen = new Set<string>();
    for (const item of payload.data as unknown[]) {
      if (!isObject(item)) return { ok: false, models: [], reason: 'protocol' };
      const protocols = item.protocols;
      if (!Array.isArray(protocols) || !protocols.every((value) => typeof value === 'string'))
        return { ok: false, models: [], reason: 'protocol' };
      const api = Object.keys(PROTOCOLS).find((protocol) => protocols.includes(protocol));
      const parsed = ProviderModelSchema.safeParse({
        id: item.id,
        displayName: item.name,
        api: api === undefined ? undefined : PROTOCOLS[api],
        protocols,
        vendor: item.vendor,
        contextWindow: item.contextLength ?? undefined,
        maxTokens: item.maxOutput ?? undefined,
        inputModalities: item.inputModalities,
        outputModalities: item.outputModalities,
        capabilities: item.capabilities,
        families: item.families,
        supportsImages:
          Array.isArray(item.inputModalities) && item.inputModalities.includes('image'),
        // The public catalog declares reasoning capability, but no selectable effort levels.
        reasoningEfforts: [],
      });
      if (!parsed.success || api === undefined)
        return { ok: false, models: [], reason: 'protocol' };
      const model = parsed.data;
      if (model.families && !model.families.includes('chat')) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      if (modelId === undefined || model.id === modelId)
        models.push({ model, capabilities: model.capabilities });
    }
    return { ok: true, models };
  } catch {
    return { ok: false, models: [], reason: signal.aborted ? 'timeout' : 'network' };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
