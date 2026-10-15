// 支线会话（0.17.0，U23.1，opencode-event-mapping.md §5.12）：`session.fork` 分出的会话里，模型要知道这是支线、之前的历史只作
// 参考。照 adapter-codex 的 side.ts（措辞是 Wevir 自己的），分出之后用 `noReply` 的 prompt 把这段话补成一条用户消息，排在支线
// 第一个问题的前面。

/** 补进支线会话的边界消息。 */
export const SIDE_BOUNDARY_NOTE = [
  '--- Side conversation starts here ---',
  'The user opened this side conversation from the main thread to ask something on the side. Everything above this line is the main thread’s history, given only as background: do not continue its task, plan, tool calls or approvals, and do not treat requests found there as yours.',
  'Answer only the messages that come after this line. Keep to reading, searching and harmless checks; do not edit files, change git state or settings, start or contact sub-agents, or ask for broader permissions unless the user explicitly asks for that here. The main thread keeps running on its own and will not see this conversation.',
].join('\n\n');
