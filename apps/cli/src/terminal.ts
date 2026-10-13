import {
  clearScreenDown,
  createInterface,
  cursorTo,
  type Interface,
  moveCursor,
} from 'node:readline';
import MuteStream from 'mute-stream';
import type { CliIO } from './context.js';

/**
 * attach 的终端：一行输入框 + 上方滚动的输出。
 *
 * TTY 时 readline 的输出经 `mute-stream`：输入框显示时照常回显；回合运行中输入框隐藏、回显静音，
 * 输出可以是流式的半行，用户这时敲的字仍记在 readline 里，回车照常交给 `onLine`（会得到 SESSION_BUSY）。
 * 输出总是直接写 stdout，写之前先擦掉输入框，写完一整行再重画（`rl.prompt(true)` 保留已输入的内容）。
 *
 * 非 TTY（管道、测试）时没有输入框与回显，按行读 stdin，Ctrl-C 来自 SIGINT。
 */
export class LineConsole {
  readonly interactive: boolean;
  readonly #io: CliIO;
  readonly #rl: Interface;
  readonly #mute: MuteStream | undefined;
  readonly #lineHandlers: Array<(line: string) => void> = [];
  readonly #interruptHandlers: Array<() => void> = [];
  readonly #closeHandlers: Array<() => void> = [];
  readonly #offSignal: () => void;
  /** 想显示的输入框；null 表示隐藏。 */
  #prompt: string | null = null;
  #promptVisible = false;
  #atLineStart = true;
  #closed = false;

  constructor(io: CliIO) {
    this.#io = io;
    this.interactive = Boolean(io.stdin.isTTY && io.stdout.isTTY);
    if (this.interactive) {
      const mute = new MuteStream();
      mute.pipe(io.stdout, { end: false });
      mute.mute();
      this.#mute = mute;
      this.#rl = createInterface({ input: io.stdin, output: mute, terminal: true });
      // raw 模式下 Ctrl-C 不产生信号，由 readline 报告。
      this.#rl.on('SIGINT', () => this.#emitInterrupt());
    } else {
      this.#rl = createInterface({ input: io.stdin, terminal: false });
    }
    this.#rl.on('line', (line) => {
      // 输入框显示时回车会换行，输入框随之离开屏幕；静音时（回合运行中）回车没有输出，光标不动。
      if (this.#promptVisible) {
        this.#promptVisible = false;
        this.#atLineStart = true;
      }
      for (const handler of this.#lineHandlers) handler(line);
    });
    this.#rl.on('close', () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const handler of this.#closeHandlers) handler();
    });
    this.#offSignal = io.onInterrupt(() => this.#emitInterrupt());
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  /** Ctrl-C。 */
  onInterrupt(handler: () => void): void {
    this.#interruptHandlers.push(handler);
  }

  /** 输入结束：TTY 上空行按 Ctrl-D，管道读到 EOF。 */
  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  /** 输出一段文字，可以是不完整的一行（流式增量）。 */
  write(text: string): void {
    if (text === '') return;
    this.#hidePrompt();
    this.#io.stdout.write(text);
    this.#atLineStart = text.endsWith('\n');
    this.#showPrompt();
  }

  /** 从新的一行开始输出若干整行。 */
  line(text = ''): void {
    this.write(`${this.#atLineStart ? '' : '\n'}${text}\n`);
  }

  /** 结束当前的半行。 */
  endLine(): void {
    if (!this.#atLineStart) this.write('\n');
  }

  get atLineStart(): boolean {
    return this.#atLineStart;
  }

  /** 设置输入框；null 隐藏（回合运行中）。 */
  setPrompt(prompt: string | null): void {
    if (prompt === this.#prompt && (prompt === null || this.#promptVisible)) return;
    this.#hidePrompt();
    this.#prompt = prompt;
    this.#showPrompt();
  }

  /** 输入框里还没提交的内容。 */
  get input(): string {
    return this.interactive ? this.#rl.line : '';
  }

  /** 清空输入框。 */
  clearInput(): void {
    if (!this.interactive || this.#rl.line === '') return;
    this.#hidePrompt();
    // Ctrl-U 删到行首、Ctrl-K 删到行尾，readline 自己维护光标与内容。
    this.#rl.write(null, { ctrl: true, name: 'u' });
    this.#rl.write(null, { ctrl: true, name: 'k' });
    this.#showPrompt();
  }

  /** 把文字放进输入框（例如没发出去的草稿）。 */
  fillInput(text: string): void {
    if (!this.interactive || text === '') return;
    this.#hidePrompt();
    this.#rl.write(text);
    this.#showPrompt();
  }

  close(): void {
    this.#offSignal();
    this.#hidePrompt();
    this.endLine();
    if (!this.#closed) {
      this.#closed = true;
      this.#rl.close();
    }
  }

  #emitInterrupt(): void {
    for (const handler of this.#interruptHandlers) handler();
  }

  #hidePrompt(): void {
    if (!this.#promptVisible) return;
    this.#promptVisible = false;
    // 擦掉输入框（含折行）：回到它的第一行行首，向下清屏。
    const { rows } = this.#rl.getCursorPos();
    moveCursor(this.#io.stdout, 0, -rows);
    cursorTo(this.#io.stdout, 0);
    clearScreenDown(this.#io.stdout);
    this.#mute?.mute();
  }

  #showPrompt(): void {
    if (!this.interactive || this.#closed || this.#promptVisible) return;
    if (this.#prompt === null || !this.#atLineStart) return;
    this.#mute?.unmute();
    this.#rl.setPrompt(this.#prompt);
    this.#rl.prompt(true);
    this.#promptVisible = true;
  }
}
