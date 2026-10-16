import type { DiscoveredProviderModel, MethodParams } from '@wevir/protocol';
import { modelRow, type ProviderForm } from './provider-form';

/** UI eligibility only; Host independently enforces the network boundary. */
export function ollamaEndpoint(baseURL: string): 'local' | 'cloud' | undefined {
  try {
    const url = new URL(baseURL);
    if (url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname))
      return undefined;
    if (url.hostname === 'ollama.com' && url.protocol === 'https:' && url.port === '')
      return 'cloud';
    if (
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      ['http:', 'https:'].includes(url.protocol)
    )
      return 'local';
  } catch {
    /* Invalid form input has no discovery action. */
  }
  return undefined;
}

export function discoveryParams(
  form: Pick<ProviderForm, 'id' | 'editing' | 'baseURL' | 'savedBaseURL' | 'apiKey'>,
): MethodParams<'provider.discoverModels'> {
  return form.editing && form.savedBaseURL === form.baseURL.trim() && form.apiKey.trim() === ''
    ? { providerId: form.id }
    : { baseURL: form.baseURL.trim(), ...(form.apiKey.trim() && { apiKey: form.apiKey.trim() }) };
}

export function toggleDiscoveredModel(
  form: ProviderForm,
  entry: DiscoveredProviderModel,
): Partial<ProviderForm> {
  const currentDefault = form.models[form.defaultIndex]?.id;
  const exists = form.models.some((row) => row.id === entry.model.id);
  const models = exists
    ? form.models.filter((row) => row.id !== entry.model.id)
    : [...form.models.filter((row) => row.id.trim()), modelRow(entry.model)];
  return {
    models,
    defaultIndex: Math.max(
      0,
      models.findIndex((row) => row.id === currentDefault),
    ),
  };
}

export const OLLAMA_AGENT_CONTEXT = 65_536;
export function lowOllamaContext(entry: DiscoveredProviderModel): number | undefined {
  const context = entry.model.contextWindow;
  return context !== undefined && context < OLLAMA_AGENT_CONTEXT ? context : undefined;
}
