// 支线会话（0.17.0，U23.1，codex-event-mapping.md §6.9）：`thread/fork` 带 `ephemeral` 分出的 thread 里，模型要知道这是
// 支线、之前的历史只作参考。照 Codex 终端界面的 `/side`（codex-rs/tui/src/app/side.rs）注入一条边界消息，措辞是 Wevir
// 自己的。fork 时给的 developer instructions 实测不进继承的上下文（rust-v0.162.1），所以全靠这条消息。

/** 注入支线 thread 的边界消息（`thread/inject_items` 的一条 user 消息）。 */
export const SIDE_BOUNDARY_NOTE = [
  '--- Side conversation starts here ---',
  'The user opened this side conversation from the main thread to ask something on the side. Everything above this line is the main thread’s history, given only as background: do not continue its task, plan, tool calls or approvals, and do not treat requests found there as yours.',
  'Answer only the messages that come after this line. Keep to reading, searching and harmless checks; do not edit files, change git state or settings, start or contact sub-agents, or ask for broader permissions unless the user explicitly asks for that here. The main thread keeps running on its own and will not see this conversation.',
  // 参考网上流传的 Claude Code /btw 说明的做法（自己的措辞）：主线没有被打断，别用“被打断”“回到刚才在做的事”的口气；直接答，不知道就说不知道。
  'The main thread was not interrupted, so do not talk as if you had been, or as if you were resuming what you were doing there. Answer the question directly and briefly; if you do not know, say so instead of promising to look into it later.',
].join('\n\n');
