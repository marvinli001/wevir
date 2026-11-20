import { contextPart } from '@wevir/runtime-adapter';
import { expect, it } from 'vitest';
import { codexTools, gatewayDeferred } from './context-supply.js';

it('subtracts loaded MCP and native definitions from the session inventory', () => {
  const active = contextPart('MCP tools', 'schema', 'read', 'files');
  const spare = contextPart('MCP tools', 'schema', 'list', 'files');
  const more = contextPart('MCP tools', 'schema', 'list', 'wevir_more');
  const inventory = codexTools(
    { cwd: '/project', modelId: 'm', providerId: 'p', contextSupply: () => [more] },
    [active, spare, more],
    true,
  );
  const loaded = [active, contextPart('System tools', 'schema', 'multi_agent_v1__spawn_agent')];
  const deferred = gatewayDeferred(loaded, inventory);
  expect(deferred.filter((p) => p.category === 'MCP tools')).toEqual([
    { ...more, deferred: true },
    { ...spare, deferred: true },
  ]);
  expect(deferred.some((p) => p.name === 'multi_agent_v1__spawn_agent')).toBe(false);
  expect(deferred.some((p) => p.name === 'multi_agent_v1__close_agent')).toBe(true);
  expect(codexTools(undefined, [active], false, 'unknown')).toEqual([active]);
});
