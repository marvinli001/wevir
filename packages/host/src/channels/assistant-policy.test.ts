import { DEFAULT_ASSISTANT_RULES, type ToolDisplay } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { actionSummary, classify, decide, type PolicyTool, words } from './assistant-policy.js';

const roots = { root: '/data/assistants/chn_1', folders: ['/Users/me/Documents'] };

const mcp = (server: string, tool: string): PolicyTool => ({
  toolName: `mcp__${server}__${tool}`,
  display: { kind: 'unknown', summary: `${server}/${tool}` },
});
const shell = (command: string): PolicyTool => ({
  toolName: 'exec_command',
  display: { kind: 'shell', summary: command, command },
  input: { command },
});
const write = (...paths: string[]): PolicyTool => ({
  toolName: 'apply_patch',
  display: { kind: 'write', paths },
});

describe('classify', () => {
  it('普通的调用：命令、联网、只读的连接器、Wevir 自己的工具与引擎的内置工具', () => {
    for (const tool of [
      shell('curl -s https://example.com'),
      shell('python3 -m http.server 47831'),
      shell('npm install'),
      mcp('gmail', 'search_messages'),
      mcp('google_calendar', 'list_events'),
      mcp('stripe', 'get_payment_status'),
      mcp('alpaca', 'get_stock_quote'),
      mcp('wevir', 'wevir_process_start'),
      mcp('wevir', 'wevir_memory_delete'),
      { toolName: 'browser_click', display: { kind: 'unknown' } as ToolDisplay },
      { toolName: 'TodoWrite', display: { kind: 'unknown' } as ToolDisplay },
      { toolName: 'web_search', display: { kind: 'search', query: 'x' } as ToolDisplay },
    ]) {
      expect(classify(tool, roots), tool.toolName).toEqual({ kind: 'routine' });
    }
  });

  it('连接器的动作按工具名归类', () => {
    const cases: [PolicyTool, string][] = [
      [mcp('gmail', 'send_email'), 'messages'],
      [mcp('slack', 'chat_postMessage'), 'messages'],
      [mcp('slack', 'reply_to_thread'), 'messages'],
      [mcp('x', 'create_tweet'), 'publishing'],
      [mcp('openship', 'deploy_app'), 'publishing'],
      [mcp('shop', 'checkout_cart'), 'purchases'],
      [mcp('amazon', 'place_order'), 'purchases'],
      [mcp('stripe', 'create_payment_link'), 'purchases'],
      [mcp('gmail', 'delete_message'), 'deletions'],
      [mcp('gdrive', 'trash_file'), 'deletions'],
      [mcp('google_calendar', 'create_event'), 'shared_edits'],
      [mcp('notion', 'update_page'), 'shared_edits'],
      [mcp('gdrive', 'share_document'), 'shared_edits'],
    ];
    for (const [tool, category] of cases) {
      expect(classify(tool, roots), tool.toolName).toEqual({ kind: 'category', category });
    }
  });

  it('转账、交易、证券硬禁止', () => {
    for (const tool of [
      mcp('bank', 'transfer_money'),
      mcp('wallet', 'withdraw'),
      mcp('paypal', 'send_payout'),
      mcp('stripe', 'create_transfer'),
      mcp('alpaca', 'place_order'),
      mcp('broker', 'buy_shares'),
      mcp('dex', 'swap_tokens'),
      mcp('exchange', 'sell_crypto'),
    ]) {
      expect(classify(tool, roots), tool.toolName).toEqual({ kind: 'forbidden' });
    }
  });

  it('命令：删除、推送发布、发邮件', () => {
    expect(classify(shell('rm -rf build'), roots)).toEqual({
      kind: 'category',
      category: 'deletions',
    });
    expect(classify(shell('cd site && git push origin main'), roots)).toEqual({
      kind: 'category',
      category: 'publishing',
    });
    expect(classify(shell('npm publish'), roots)).toEqual({
      kind: 'category',
      category: 'publishing',
    });
    expect(classify(shell('sudo rm /tmp/x'), roots)).toEqual({
      kind: 'category',
      category: 'deletions',
    });
    // 拆不开的命令（重定向）也大致看出来。
    expect(classify(shell('echo hi > a.txt; rm a.txt'), roots)).toEqual({
      kind: 'category',
      category: 'deletions',
    });
    expect(classify(shell('mail -s hi me@example.com < body.txt'), roots)).toEqual({
      kind: 'category',
      category: 'messages',
    });
  });

  it('改文件：工作区与授权文件夹里是本机文件，之外的照常问', () => {
    expect(classify(write('notes/today.md'), roots)).toEqual({
      kind: 'category',
      category: 'local_files',
    });
    expect(classify(write('/Users/me/Documents/a.txt'), roots)).toEqual({
      kind: 'category',
      category: 'local_files',
    });
    expect(classify(write('/Users/me/Desktop/a.txt'), roots)).toEqual({ kind: 'outside' });
    expect(classify(write('../escape.txt'), roots)).toEqual({ kind: 'outside' });
  });
});

describe('decide', () => {
  it('按档位答：do / tell 允许，ask 问，hand_off 拒绝；硬禁止任何档都拒绝', () => {
    const rules = { ...DEFAULT_ASSISTANT_RULES, deletions: 'do' as const };
    expect(decide({ kind: 'routine' }, rules)).toEqual({ decision: 'allow' });
    expect(decide({ kind: 'outside' }, rules)).toEqual({ decision: 'ask' });
    expect(decide({ kind: 'category', category: 'messages' }, rules)).toEqual({ decision: 'ask' });
    expect(decide({ kind: 'category', category: 'local_files' }, rules)).toEqual({
      decision: 'allow',
    });
    expect(decide({ kind: 'category', category: 'deletions' }, rules)).toEqual({
      decision: 'allow',
    });
    expect(decide({ kind: 'category', category: 'purchases' }, rules)).toEqual({
      decision: 'reject',
      notice: 'handed_off',
      category: 'purchases',
    });
    const everything = Object.fromEntries(
      Object.keys(DEFAULT_ASSISTANT_RULES).map((key) => [key, 'do']),
    ) as Parameters<typeof decide>[1];
    expect(decide({ kind: 'forbidden' }, everything)).toEqual({
      decision: 'reject',
      notice: 'blocked',
    });
  });

  it('规矩里没写的种类用默认档', () => {
    expect(decide({ kind: 'category', category: 'publishing' }, {})).toEqual({ decision: 'ask' });
  });
});

describe('words / actionSummary', () => {
  it('拆工具名，摘要优先用展示的', () => {
    expect(words('chat_postMessage')).toEqual(['chat', 'post', 'message']);
    expect(words('calendar.events.insert')).toEqual(['calendar', 'events', 'insert']);
    expect(actionSummary(mcp('gmail', 'send_email'))).toBe('gmail/send_email');
    expect(actionSummary({ toolName: 'x', display: { kind: 'unknown' } })).toBe('x');
  });
});
