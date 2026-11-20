import { type ContextPart, contextPart, instructionParts } from '@wevir/runtime-adapter';
import { SYSTEM_AS_USER_NOTE } from './chat/request.js';
import { foundToolEntries, foundToolText } from './tool-search.js';
import { flatToolName, isObject, mcpNamespaceNotes } from './tools.js';
import type { JsonObject, ResponsesRequest } from './types.js';

export interface ContextFile {
  name: string;
  text: string;
}

export function requestContextParts(
  body: JsonObject,
  mode: 'responses' | 'chat' | 'messages' | 'gemini',
  source: ResponsesRequest,
  files: readonly ContextFile[] = [],
): ContextPart[] {
  const parts: ContextPart[] = [];
  const notes = mcpNamespaceNotes(source.tools);
  const names = new Map<string, { name: string; namespace?: string }>();
  const found = new Map<string, ReturnType<typeof foundToolEntries>>();
  const sourceInput = Array.isArray(source.input) ? source.input : [];
  for (const entry of sourceInput) {
    if (entry.type === 'tool_search_output' && Array.isArray(entry.tools)) {
      const tools = foundToolEntries(entry.tools);
      found.set(foundToolText(tools), tools);
    }
  }
  for (const tool of source.tools ?? []) {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) {
        if (typeof inner.name === 'string')
          names.set(flatToolName(inner.name, tool.name), {
            name: inner.name,
            namespace: tool.name,
          });
      }
    }
  }
  function addTool(tool: JsonObject, namespace?: string, serialized = JSON.stringify(tool)) {
    const flat = String(
      (isObject(tool.function) ? tool.function.name : tool.name) ?? tool.type ?? '',
    );
    const origin = names.get(flat);
    const full = namespace
      ? `${namespace}__${flat}`
      : origin?.namespace
        ? `${origin.namespace}__${origin.name}`
        : flat;
    const mcp = /^mcp__(.+?)__(.+)$/.exec(full);
    parts.push(
      contextPart(mcp ? 'MCP tools' : 'System tools', serialized, mcp?.[2] ?? full, mcp?.[1]),
    );
  }
  function addDefinitions(tools: unknown) {
    if (!Array.isArray(tools)) return;
    for (const tool of tools.filter(isObject)) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const declaration of tool.functionDeclarations.filter(isObject)) addTool(declaration);
      } else if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
        const { tools: children, description, ...wrapper } = tool;
        const mcp = String(tool.name).startsWith('mcp__');
        if (typeof description === 'string') {
          parts.push(
            ...(mcp
              ? instructionParts(description, 'MCP server instructions')
              : [contextPart('System tools', description)]),
          );
        }
        parts.push(contextPart(mcp ? 'MCP tools' : 'System tools', JSON.stringify(wrapper)));
        for (const child of children.filter(isObject)) addTool(child, String(tool.name));
      } else addTool(tool);
    }
  }
  function system(text: string) {
    const index = notes ? text.indexOf(notes) : -1;
    if (notes && index >= 0) {
      parts.push(...instructionParts(notes, 'MCP server instructions'));
      text = text.slice(0, index) + text.slice(index + notes.length);
    }
    text = text.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, (block) => {
      const rest = block.replace(
        /^- ([^:\n]+): [^\n]+\(file: [^\n]+\)$/gm,
        (line, name: string) => {
          parts.push(contextPart('Skills', line, name));
          return '';
        },
      );
      parts.push(contextPart('Skills', rest));
      return '';
    });
    parts.push(...instructionParts(text, 'System prompt'));
  }
  function content(value: unknown, role: unknown) {
    if (Array.isArray(value)) {
      for (const block of value) content(block, role);
      return;
    }
    if (
      isObject(value) &&
      typeof value.text === 'string' &&
      (!value.type || ['text', 'input_text', 'output_text'].includes(String(value.type)))
    ) {
      content(value.text, role);
    } else if (isObject(value) && value.type === 'tool_result') {
      content(value.content, 'tool');
    } else if (isObject(value) && isObject(value.functionResponse)) {
      const response = value.functionResponse.response;
      content(isObject(response) ? (response.output ?? response) : response, 'tool');
    } else if (typeof value === 'string') {
      if (
        role === 'system' ||
        role === 'developer' ||
        (role === 'user' && value.startsWith(`${SYSTEM_AS_USER_NOTE}\n`))
      )
        return system(value);
      const agents =
        role === 'user' &&
        /^# AGENTS\.md instructions for ([^\n]+)\n+<INSTRUCTIONS>\n([\s\S]*?)\n<\/INSTRUCTIONS>(?=\n|$)/.exec(
          value,
        );
      if (agents) {
        let rest = agents[0];
        for (const file of files) {
          if (!file.text || !rest.includes(file.text)) continue;
          rest = rest.replace(file.text, '');
          parts.push(contextPart('Memory files', file.text, file.name));
        }
        // 一个未拆开的引擎指令块只列一次；匹配了文件时，包装文本只计入类别。
        parts.push(
          contextPart(
            'Memory files',
            rest,
            rest === agents[0] ? `${agents[1]}/AGENTS.md` : undefined,
          ),
        );
        content(value.slice(agents[0].length), role);
      } else if (role === 'tool' && found.has(value)) {
        let remainder = value;
        for (const tool of found.get(value) ?? []) {
          const line = JSON.stringify(tool);
          addTool(tool, undefined, line);
          remainder = remainder.replace(line, '');
        }
        parts.push(contextPart('Messages', remainder));
      } else parts.push(contextPart('Messages', value));
    } else if (value != null) parts.push(contextPart('Messages', JSON.stringify(value)));
  }
  addDefinitions(body.tools);
  if (mode === 'responses') content(body.instructions, 'system');
  if (mode === 'messages') content(body.system, 'system');
  if (mode === 'gemini' && isObject(body.systemInstruction))
    content(body.systemInstruction.parts, 'system');
  const messages =
    mode === 'responses' ? body.input : mode === 'gemini' ? body.contents : body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isObject(message)) {
        content(message, 'user');
        continue;
      }
      if (message.type === 'tool_search_output') addDefinitions(message.tools);
      else if (message.type === 'function_call_output') content(message.output, 'tool');
      else if ('content' in message || 'parts' in message) {
        const { role, content: blocks, parts: geminiParts, type: _type, ...extra } = message;
        content(blocks ?? geminiParts, role);
        if (Object.keys(extra).length) content(extra, 'assistant');
      } else content(message, 'assistant');
    }
  } else content(messages, 'user');
  return parts.filter((part) => part.bytes > 0);
}
