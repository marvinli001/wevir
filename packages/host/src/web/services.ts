import { bochaService } from './bocha.js';
import type { WebSearchService } from './search.js';
import { tavilyService } from './tavily.js';

/** Host 支持的搜索服务，按设置里显示的顺序；第一个是默认（博查，国内直连可用）。 */
export const SEARCH_SERVICES: readonly WebSearchService[] = [bochaService, tavilyService];

export function searchService(id: string): WebSearchService | undefined {
  return SEARCH_SERVICES.find((service) => service.id === id);
}
