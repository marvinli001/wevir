// Observed Claude Code 2.1.304–2.1.309 JSONL, not an SDK contract: user.content is a string or blocks;
// assistant blocks share message IDs; tool results are user records, not new turns. Ignore sidechains,
// meta messages and bookkeeping. Unknown records/blocks count as skipped; never retain signatures,
// request blobs, credentials or binary attachments. Older string-content records remain readable.
import { record } from '../plugin-skills.js';
import {
  cleanInput,
  firstPrompt,
  type SessionParser,
  sessionInfo,
  sessionLines,
  textContent,
  timestamp,
  toolDisplay,
  touch,
  validInfo,
} from './session-jsonl.js';

const BOOKKEEPING = new Set([
  'queue-operation',
  'attachment',
  'last-prompt',
  'custom-title',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'api-request-shape',
  'api-request-blob',
  'api-request',
  'bridge-session',
  'cost-state',
  'mode',
  'summary',
  'progress',
  'system',
]);

export const parseClaudeSession: SessionParser = async (path, visit) => {
  const info = sessionInfo();
  let previousUuid: string | undefined;
  for await (const line of sessionLines(path)) {
    if (line === null) {
      info.skipped++;
      continue;
    }
    if (line.isSidechain === true || line.isMeta === true) continue;
    if (BOOKKEEPING.has(String(line.type))) continue;
    if (line.type !== 'user' && line.type !== 'assistant') {
      info.skipped++;
      continue;
    }
    const at = timestamp(line.timestamp);
    if (at === undefined) {
      info.skipped++;
      continue;
    }
    if (typeof line.uuid === 'string') {
      if (previousUuid === line.uuid) continue;
      previousUuid = line.uuid;
    }
    if (typeof line.sessionId === 'string') info.externalId = line.sessionId;
    if (typeof line.cwd === 'string') info.project = line.cwd;
    touch(info, at);
    const message = record(line.message);
    if (line.type === 'assistant' && typeof message.model === 'string')
      info.modelId = message.model;
    const content = message.content;
    const text = textContent(content);
    if (line.type === 'user' && text !== '') {
      firstPrompt(info, text);
      info.turns++;
      await visit?.({ kind: 'user', at, text });
    } else if (line.type === 'assistant' && text !== '') {
      await visit?.({
        kind: 'assistant',
        at,
        text,
        ...(typeof line.uuid === 'string' && { id: line.uuid }),
      });
    }
    let unknown = false;
    for (const value of Array.isArray(content) ? content : []) {
      const block = record(value);
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        const input = cleanInput(block.input);
        await visit?.({
          kind: 'tool',
          at,
          id: block.id,
          name: block.name,
          input,
          display: toolDisplay(block.name, input),
        });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        await visit?.({
          kind: 'result',
          at,
          id: block.tool_use_id,
          text: textContent(block.content),
          failed: block.is_error === true,
        });
      } else if (!['text', 'thinking', 'image', 'tool_addition'].includes(String(block.type)))
        unknown = true;
    }
    if (unknown || (typeof content !== 'string' && !Array.isArray(content))) info.skipped++;
    if (line.type === 'assistant' && message.stop_reason === 'end_turn')
      await visit?.({ kind: 'end', at });
  }
  return validInfo(info);
};
