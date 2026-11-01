// 会话回报的正文（Host 发给模型的英文外壳）里给人看的部分：桌面端与手机端的消息流共用。纯逻辑。

/**
 * 回报正文（Host 发给模型的英文外壳：一条或几条 `reportText` 的笔记，用 `---` 隔开，后面是读全文的提示与有关会话的状态）里给人
 * 看的部分：每个会话的回答，没有回答时是错误；几个会话合在一起时每段前面写上会话标题。认不出时原样返回。
 */
const REPORT_NOTE =
  /^Session ses_[0-9A-Za-z]+(?: "([\s\S]*?)")? finished a turn (?:you asked for|the user ran there) \(\w+\)\.(?:\nError: ([^\n]*))?\n(?:Its final answer:\n\n([\s\S]*)|It gave no final answer\.)$/;
const REPORT_TAIL =
  /\n\nRead (?:a|the) whole conversation with wevir_session_read if you need more\.(?:\n\n[\s\S]*)?$/;

export function reportBody(text: string): string {
  const tail = REPORT_TAIL.exec(text);
  if (!tail) return text;
  const notes = text.slice(0, tail.index).split('\n\n---\n\n');
  const parsed = notes.map((note) => REPORT_NOTE.exec(note));
  if (parsed.some((match) => match === null)) return text;
  const bodies = parsed.map((match) => ({
    title: match?.[1],
    body: match?.[3] ?? match?.[2] ?? '',
  }));
  if (bodies.length === 1) return bodies[0]?.body ?? '';
  return bodies
    .map(({ title, body }) => (title ? `**${title}**\n\n${body}` : body))
    .join('\n\n---\n\n');
}
