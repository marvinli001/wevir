// Codex rollout envelope verified against upstream/codex codex-rs/{history,protocol,rollout}:
// timestamp/type/payload, with optional ordinal/metadata in newer versions. response_item is canonical;
// event_msg user_message/agent_message are duplicate display notifications. task_started/task_complete
// delimit turns (older turn_started/turn_complete also accepted). No encrypted reasoning is imported.
// Shared-prefix history_base is counted as skipped and disallows native resume; it is never followed.
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

export const parseCodexSession: SessionParser = async (path, visit) => {
  const info = sessionInfo();
  let inTurn = false;
  let userInTurn = false;
  for await (const line of sessionLines(path)) {
    if (line === null) {
      info.skipped++;
      continue;
    }
    const payload = record(line.payload);
    const at = timestamp(line.timestamp);
    if (at === undefined) {
      info.skipped++;
      continue;
    }
    touch(info, at);
    if (line.type === 'session_meta') {
      if (typeof payload.id === 'string') info.externalId = payload.id;
      if (typeof payload.cwd === 'string') info.project = payload.cwd;
      if (payload.history_base != null) {
        info.skipped++;
        info.nativeCompatible = false;
      }
    } else if (line.type === 'turn_context') {
      if (typeof payload.model === 'string') info.modelId = payload.model;
    } else if (line.type === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        inTurn = true;
        userInTurn = false;
      } else if (
        ['task_complete', 'turn_complete', 'turn_aborted'].includes(String(payload.type))
      ) {
        await visit?.({
          kind: 'end',
          at,
          ...(payload.type === 'turn_aborted' && { interrupted: true }),
        });
        inTurn = false;
        userInTurn = false;
      } else if (
        ![
          'user_message',
          'agent_message',
          'agent_reasoning',
          'agent_reasoning_raw_content',
          'token_count',
          'item_started',
          'item_completed',
          'exec_command_begin',
          'exec_command_end',
          'exec_command_output_delta',
          'patch_apply_begin',
          'patch_apply_end',
          'thread_settings_applied',
          'context_compacted',
          'mcp_startup_update',
          'mcp_startup_complete',
        ].includes(String(payload.type))
      )
        info.skipped++;
    } else if (line.type === 'response_item') {
      if (payload.type === 'message') {
        const text = textContent(payload.content);
        if (payload.role === 'user' && text !== '') {
          // These are generated bootstrap records, not the task's first user prompt.
          if (
            text.startsWith('# AGENTS.md instructions for ') ||
            text.startsWith('<environment_context>')
          )
            continue;
          firstPrompt(info, text);
          if (!inTurn || !userInTurn) info.turns++;
          userInTurn = true;
          await visit?.({ kind: 'user', at, text });
        } else if (payload.role === 'assistant' && text !== '') {
          await visit?.({
            kind: 'assistant',
            at,
            text,
            ...(typeof payload.id === 'string' && { id: payload.id }),
          });
        }
      } else if (
        ['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(payload.type))
      ) {
        const id = payload.call_id ?? payload.id;
        const name = payload.type === 'local_shell_call' ? 'local_shell' : payload.name;
        if (typeof id !== 'string' || typeof name !== 'string') {
          info.skipped++;
          continue;
        }
        let input: unknown = payload.input ?? payload.action;
        if (typeof payload.arguments === 'string') {
          try {
            input = JSON.parse(payload.arguments);
          } catch {
            input = payload.arguments;
          }
        }
        input = cleanInput(input);
        await visit?.({ kind: 'tool', at, id, name, input, display: toolDisplay(name, input) });
      } else if (
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output'
      ) {
        if (typeof payload.call_id !== 'string') {
          info.skipped++;
          continue;
        }
        await visit?.({
          kind: 'result',
          at,
          id: payload.call_id,
          text: textContent(payload.output),
          failed: false,
        });
      } else if (
        !['reasoning', 'additional_tools', 'compaction', 'web_search_call'].includes(
          String(payload.type),
        )
      )
        info.skipped++;
    } else if (!['compacted', 'world_state', 'token_usage_record'].includes(String(line.type)))
      info.skipped++;
  }
  return validInfo(info);
};
