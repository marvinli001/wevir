// 各场景的提示词，以及 mock 模型对每个场景的脚本。
// 每个提示词以 [wevir:<场景>] 开头：真实模型会忽略它，mock 靠它决定下一步。
// mock 只看请求里的 messages（与真实 Provider 一样），所以 resume 后能不能答对，
// 取决于 dsh 是否把历史完整发了过来。

import { type ChatMessage, type ChatRequest, type Reply, textOf } from './mock-llm.ts';

export const CSV = 'city,count\n北京,3\n上海,5\n深圳,7\n';

export const prompts = {
  ok: '[wevir:OK] 只回复两个字母：OK',
  readWrite: (codeword: string) =>
    `[wevir:A] 读取工作区里的 input.csv，把 count 列求和，然后把结果写入 summary.md，内容只有一行：total=<和>。另外请记住这个暗号：${codeword}，之后我会问你。`,
  escalation: (path: string) =>
    [
      `[wevir:ESC] 请用 write 工具在绝对路径 ${path} 创建文件，内容只有一行：hello。`,
      '这个路径在工作区之外，沙箱会先拒绝；被拒绝后请按工具提示带上 sandbox_permissions',
      '（取最窄的更高权限）和一句 justification 重试一次，这会向我申请审批。',
      '无论结果如何，最后用一句话告诉我文件是否已经写入。',
    ].join(''),
  longTool: '[wevir:SLEEP] 用 bash 执行命令 `sleep 45 && echo finished`，等它结束后把输出告诉我。',
  longText:
    '[wevir:LONG] 不要调用任何工具。请写一篇约 3000 字的文章，介绍中国四大发明的历史与影响。',
  stream: '[wevir:STREAM] 不要调用任何工具。用大约 300 字介绍一下杭州西湖。',
  recall: '[wevir:RECALL] 我之前让你记住的暗号是什么？只回答暗号本身。',
  recallAll:
    '[wevir:RECALL] 不要调用任何工具，只凭记忆回答：1）我让你记住的暗号；2）你之前写入 summary.md 的内容；3）哪些写入请求被拒绝或取消了。',
  token: '[wevir:TOKEN] 读取工作区里的 token.txt，只回复文件内容本身，不要别的文字。',
  todoSubagent: [
    '[wevir:TODO] 请按顺序做：1）先用 todo_write 工具列出三步计划（读取、统计、写入）；',
    '2）用 subagent 工具派一个子 agent 读取 input.csv，让它告诉你数据有几行（不含表头）；',
    '3）把行数写入 rows.txt；4）用 todo_write 把三步都标记为完成。',
  ].join(''),
  child: '[wevir:CHILD] 读取当前目录下的 input.csv，只回答数据有几行（不含表头），只回复数字。',
};

const TAG = /\[wevir:([A-Z]+)\]/;

/** 当前轮次：最后一条带场景标记的用户消息，以及它之后的工具结果。 */
function turnOf(messages: ChatMessage[]) {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && TAG.test(textOf(m.content))) {
      index = i;
      break;
    }
  }
  const prompt = index >= 0 ? textOf(messages[index]?.content) : '';
  const after = messages.slice(index + 1);
  return {
    scenario: TAG.exec(prompt)?.[1] ?? '',
    prompt,
    results: after.filter((m) => m.role === 'tool').map((m) => textOf(m.content)),
    calls: after.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name),
    later: after.filter((m) => m.role === 'user').map((m) => textOf(m.content)),
  };
}

/** read 工具结果形如 `<path>…</path><type>file</type><content>\n1: 行…\n(End of file …)</content>`。 */
const fileLines = (toolResult: string): string[] => {
  const body = /<content>\n([\s\S]*?)\n<\/content>/.exec(toolResult)?.[1] ?? toolResult;
  return body
    .split('\n')
    .filter((line) => /^\d+: /.test(line))
    .map((line) => line.replace(/^\d+: /, ''));
};

const ARTICLE = '指南针、造纸术、印刷术与火药被并称为中国古代四大发明。'.repeat(80);
const WEST_LAKE =
  '西湖位于浙江省杭州市西部，三面环山，一面临城，湖面约六点五平方公里。苏堤与白堤把湖面分隔开来，断桥残雪、平湖秋月、三潭印月等十景各有季节。白居易与苏轼都曾在杭州为官并疏浚西湖，留下诗文与堤岸。二〇一一年西湖文化景观列入世界遗产名录。今天的西湖既是市民散步的公园，也是游客最集中的景区，春天看桃柳，夏天赏荷花，秋天闻桂香，冬天看雪后的断桥。';

/** mock 模型：按场景和已有工具结果给出下一步。 */
export function mockScript(req: ChatRequest): Reply {
  const { scenario, prompt, results, calls, later } = turnOf(req.messages);
  const n = results.length;
  switch (scenario) {
    case 'OK':
      return { text: 'OK' };
    case 'A': {
      if (n === 0) {
        return {
          reasoning: '先读取 input.csv。',
          toolCalls: [{ name: 'read', arguments: { file_path: 'input.csv' } }],
        };
      }
      const sum = [...(results[0] ?? '').matchAll(/,(\d+)\s*$/gm)].reduce(
        (acc, m) => acc + Number(m[1]),
        0,
      );
      if (n === 1) {
        return {
          toolCalls: [
            { name: 'write', arguments: { file_path: 'summary.md', content: `total=${sum}\n` } },
          ],
        };
      }
      return { text: `已把 total=${sum} 写入 summary.md，暗号也记住了。`, chunks: 6 };
    }
    case 'ESC': {
      const path = /绝对路径 (\S+?) 创建/.exec(prompt)?.[1] ?? '/tmp/wevir-unknown.txt';
      const write = { file_path: path, content: 'hello\n' };
      if (n === 0) return { toolCalls: [{ name: 'write', arguments: write }] };
      if (n === 1 && /sandbox/i.test(results[0] ?? '')) {
        return {
          toolCalls: [
            {
              name: 'write',
              arguments: {
                ...write,
                sandbox_permissions: 'danger-full-access',
                justification: '用户要求在工作区之外创建这个文件。',
              },
            },
          ],
        };
      }
      return { text: `结果：${(results.at(-1) ?? '').slice(0, 120)}` };
    }
    case 'SLEEP':
      if (n === 0) {
        return {
          toolCalls: [
            {
              name: 'bash',
              arguments: { command: 'sleep 45 && echo finished', description: 'Sleep 45s' },
            },
          ],
        };
      }
      return { text: `命令输出：${results[0] ?? ''}` };
    case 'LONG':
      return { text: ARTICLE, chunks: 300, chunkDelayMs: 100 };
    case 'STREAM':
      return { reasoning: '简单介绍即可。', text: WEST_LAKE, chunks: 30, chunkDelayMs: 100 };
    case 'RECALL': {
      // 只凭请求里的历史作答：在此前的用户消息里找暗号，在此前的 write 调用里找 summary.md 内容
      const history = req.messages.slice(0, -1);
      const codeword = history
        .map((m) =>
          m.role === 'user' ? /wevir-[0-9a-f]{6}/.exec(textOf(m.content))?.[0] : undefined,
        )
        .find((x) => x !== undefined);
      const summary = history
        .flatMap((m) => m.tool_calls ?? [])
        .map((c) => JSON.parse(c.function.arguments) as { file_path?: string; content?: string })
        .find((a) => a.file_path === 'summary.md')?.content;
      if (codeword === undefined) return { text: '我不记得有暗号。' };
      return {
        text: `暗号：${codeword}；summary.md：${summary?.trim() ?? '不记得'}；历史消息数：${history.length}`,
      };
    }
    case 'TOKEN':
      if (n === 0) return { toolCalls: [{ name: 'read', arguments: { file_path: 'token.txt' } }] };
      return { text: fileLines(results[0] ?? '').join('\n') };
    case 'TODO': {
      // subagent 是后台子 agent：工具结果只有 "started subagent <id>"，
      // 子 agent 的结论稍后以一条 "Background subagent … Its closing message:" 用户消息送回。
      const todos = (done: number) =>
        ['读取 input.csv', '统计数据行数', '写入 rows.txt'].map((content, i) => ({
          content,
          status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
        }));
      const closing = later.find((text) => text.includes('closing message'));
      const count = (name: string) => calls.filter((c) => c === name).length;
      if (count('todo_write') === 0) {
        return { toolCalls: [{ name: 'todo_write', arguments: { todos: todos(0) } }] };
      }
      if (count('subagent') === 0) {
        return {
          toolCalls: [
            { name: 'subagent', arguments: { description: '统计数据行数', prompt: prompts.child } },
          ],
        };
      }
      if (closing === undefined) return { text: '已派出子 agent，等它回报行数。' };
      if (count('write') === 0) {
        const rows = /(\d+)\s*$/.exec(closing)?.[1] ?? '?';
        return {
          toolCalls: [
            { name: 'write', arguments: { file_path: 'rows.txt', content: `${rows}\n` } },
          ],
        };
      }
      if (count('todo_write') === 1) {
        return { toolCalls: [{ name: 'todo_write', arguments: { todos: todos(3) } }] };
      }
      return { text: '三步都完成了。' };
    }
    case 'CHILD':
      if (n === 0) return { toolCalls: [{ name: 'read', arguments: { file_path: 'input.csv' } }] };
      return { text: String(Math.max(0, fileLines(results[0] ?? '').length - 1)) };
    default:
      return { text: `mock 不认识这个场景：${prompt.slice(0, 40)}` };
  }
}
