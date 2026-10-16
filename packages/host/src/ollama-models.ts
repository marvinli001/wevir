// Ollama metadata stays in Host; see providers.md §7.5 and host-api.md §3.
import type {
  DiscoveredProviderModel,
  MethodResult,
  ProviderReasoningLevel,
  ProviderTestFailure,
} from '@wevir/protocol';
import { HostError } from './errors.js';

const MAX_MODELS = 64;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EFFORTS: ProviderReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type ObjectValue = Record<string, unknown>;
type Discovery = MethodResult<'provider.discoverModels'>;

/** Fixed paths on loopback or exact HTTPS ollama.com; no arbitrary proxy or redirects. */
export function ollamaOrigin(baseURL: string): { origin: string; cloud: boolean } {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw invalidTarget();
  }
  const cloud = url.hostname === 'ollama.com' && url.protocol === 'https:' && url.port === '';
  const local =
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    ['http:', 'https:'].includes(url.protocol);
  if (
    (!cloud && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/?$/.test(url.pathname)
  )
    throw invalidTarget();
  // localhost must never resolve outside loopback, even with a changed hosts file.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return { origin: url.origin, cloud };
}

function invalidTarget(): HostError {
  return new HostError(
    'INVALID_PARAMS',
    'Ollama discovery requires loopback /v1 or https://ollama.com/v1',
    {
      issues: [{ path: ['baseURL'], message: 'unsupported Ollama discovery address' }],
    },
  );
}

export async function discoverOllamaModels(
  params: { baseURL: string; apiKey?: string | undefined; modelId?: string | undefined },
  doFetch: typeof fetch = fetch,
): Promise<Discovery> {
  const { origin, cloud } = ollamaOrigin(params.baseURL);
  if (cloud && !params.apiKey) return { ok: false, models: [], reason: 'missing_key' };
  const signal = AbortSignal.timeout(15_000);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${params.apiKey ?? 'ollama'}`,
  };
  const request = async (path: '/api/tags' | '/api/show' | '/api/ps', model?: string) => {
    const response = await doFetch(`${origin}${path}`, {
      method: model === undefined ? 'GET' : 'POST',
      headers,
      ...(model === undefined ? {} : { body: JSON.stringify({ model }) }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiscoveryFailure(
        response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'server'
              : 'protocol',
      );
    }
    return readObject(response);
  };
  try {
    const tags = await request('/api/tags');
    if (!Array.isArray(tags.models)) throw new DiscoveryFailure('protocol');
    const seen = new Set<string>();
    const all = tags.models.filter(isObject).filter((item) => {
      const name = textValue(item.name) ?? textValue(item.model);
      if (!name || name.length > 512 || seen.has(name)) return false;
      seen.add(name);
      return params.modelId === undefined || sameModel(name, params.modelId);
    });
    const selected = all.slice(0, MAX_MODELS);
    // A model may only be visible in /show on older remote catalogs.
    if (params.modelId && selected.length === 0) selected.push({ name: params.modelId });
    let running: ObjectValue[] = [];
    if (!cloud) {
      const ps = await request('/api/ps').catch(() => undefined);
      if (Array.isArray(ps?.models)) running = ps.models.filter(isObject);
    }
    const models: DiscoveredProviderModel[] = new Array(selected.length);
    let next = 0;
    // Two metadata requests at a time, sharing the deadline for the whole operation.
    const worker = async () => {
      while (next < selected.length) {
        const index = next++;
        const tag = selected[index];
        if (!tag) continue;
        const id = textValue(tag.name) ?? String(tag.model);
        const show = await request('/api/show', id).catch(() => undefined);
        const active = running.find((item) => sameModel(String(item.name ?? item.model), id));
        models[index] = describeModel(tag, id, show, active, cloud);
      }
    };
    await Promise.all([worker(), worker()]);
    if (signal.aborted) return { ok: false, models: [], reason: 'timeout' };
    return { ok: true, models, ...(all.length > MAX_MODELS && { truncated: true }) };
  } catch (error) {
    return {
      ok: false,
      models: [],
      reason: signal.aborted
        ? 'timeout'
        : error instanceof DiscoveryFailure
          ? error.reason
          : 'network',
    };
  }
}

function describeModel(
  tag: ObjectValue,
  id: string,
  show: ObjectValue | undefined,
  active: ObjectValue | undefined,
  cloud: boolean,
): DiscoveredProviderModel {
  const info = isObject(show?.model_info) ? show.model_info : {};
  const maxContext = Object.entries(info)
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, value]) => positiveInteger(value))
    .find((value) => value !== undefined);
  const configured = positiveInteger(
    Number(textValue(show?.parameters)?.match(/^\s*num_ctx\s+(\d+)\s*$/m)?.[1]),
  );
  const allocated = positiveInteger(active?.context_length);
  const remoteHost = safeRemoteHost(tag.remote_host);
  const remote = cloud || remoteHost === 'https://ollama.com';
  const contextWindow = remote ? maxContext : (allocated ?? configured);
  const capabilities = stringArray(show?.capabilities) ?? stringArray(tag.capabilities);
  const thinking = isObject(show?.thinking) ? show.thinking : undefined;
  let reasoningEfforts: ProviderReasoningLevel[] | undefined;
  if (Array.isArray(thinking?.values)) {
    const values = thinking.values;
    reasoningEfforts = EFFORTS.filter((effort) => values.includes(effort));
    // Booleans are expressed through the OpenAI compatibility effort mapping.
    if (values.includes(true) && reasoningEfforts.length === 0) reasoningEfforts.push('medium');
    if (values.includes(false) || values.includes('none')) reasoningEfforts.unshift('off');
    if (values.length === 1 && values[0] === false) reasoningEfforts = [];
  }
  const details = isObject(tag.details) ? tag.details : {};
  return {
    model: {
      id,
      ...(contextWindow !== undefined && { contextWindow }),
      ...(capabilities && { supportsImages: capabilities.includes('vision') }),
      ...(reasoningEfforts !== undefined && { reasoningEfforts }),
    },
    ...(capabilities && { capabilities }),
    ...(Number.isSafeInteger(tag.size) && Number(tag.size) >= 0 && { sizeBytes: Number(tag.size) }),
    ...(textValue(details.parameter_size) && {
      parameterSize: String(details.parameter_size).slice(0, 128),
    }),
    ...(textValue(details.quantization_level) && {
      quantization: String(details.quantization_level).slice(0, 128),
    }),
    ...(remoteHost && { remoteHost }),
    ...(maxContext !== undefined && { maxContextWindow: maxContext }),
    ...(contextWindow !== undefined && {
      contextSource: remote ? 'cloud' : allocated !== undefined ? 'running' : 'configured',
    }),
    detailsAvailable: show !== undefined,
  };
}

async function readObject(response: Response): Promise<ObjectValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new DiscoveryFailure('protocol');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new DiscoveryFailure('protocol');
      chunks.push(value);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DiscoveryFailure('protocol');
    }
    if (!isObject(value)) throw new DiscoveryFailure('protocol');
    return value;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class DiscoveryFailure extends Error {
  constructor(readonly reason: ProviderTestFailure) {
    super(reason);
  }
}

function sameModel(a: string, b: string): boolean {
  return a === b || `${a}:latest` === b || a === `${b}:latest`;
}
function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function safeRemoteHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.slice(0, 64).map((item: string) => item.slice(0, 128))
    : undefined;
}
