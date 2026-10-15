import { createInterface, type Interface } from 'node:readline';
import MuteStream from 'mute-stream';
import type { CliIO } from './context.js';
import { CliError, EXIT } from './errors.js';
import { t } from './i18n/index.js';

/**
 * 一问一答的交互输入（`provider add`）。TTY 时 readline 的输出经 `mute-stream`，输入 Key 时静音，
 * 不回显；非 TTY（管道）时逐行读 stdin，不显示问题。行先进缓冲再被取走，管道里一次到达的多行不会丢。
 * Ctrl-C 以 `CliError`（退出码 130）结束。
 */
export class Questioner {
  readonly interactive: boolean;
  readonly #io: CliIO;
  readonly #rl: Interface;
  readonly #mute: MuteStream | undefined;
  readonly #lines: AsyncIterator<string>;
  #interrupted = false;

  constructor(io: CliIO) {
    this.#io = io;
    this.interactive = Boolean(io.stdin.isTTY);
    if (this.interactive) {
      const mute = new MuteStream();
      mute.pipe(io.stdout, { end: false });
      this.#mute = mute;
      this.#rl = createInterface({ input: io.stdin, output: mute, terminal: true });
      this.#rl.on('SIGINT', () => {
        this.#interrupted = true;
        this.#rl.close();
      });
    } else {
      this.#rl = createInterface({ input: io.stdin, terminal: false });
    }
    this.#lines = this.#rl[Symbol.asyncIterator]();
  }

  /** 读一行。`fallback` 是直接回车时的取值。 */
  async ask(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? `[${fallback}] ` : '';
    const answer = (await this.#read(`${question}${suffix}`)).trim();
    return answer === '' ? (fallback ?? '') : answer;
  }

  /** 读一行，不回显（API Key）。 */
  async askSecret(question: string): Promise<string> {
    return (await this.#read(question, true)).trim();
  }

  /** 不提示，读一行；输入已结束时返回 undefined。 */
  async readLine(): Promise<string | undefined> {
    const next = await this.#lines.next();
    if (this.#interrupted) throw new CliError(t('prompt.cancelled'), undefined, EXIT.interrupted);
    return next.done ? undefined : next.value;
  }

  /** 从列表里选一项，返回序号（从 0 开始）。 */
  async choose(question: string, options: string[], fallback = 0): Promise<number> {
    if (this.interactive) {
      this.#io.stdout.write(`${question}\n`);
      options.forEach((option, i) => {
        this.#io.stdout.write(`  ${i + 1}) ${option}\n`);
      });
    }
    for (;;) {
      const answer = await this.ask(t('prompt.choose'), String(fallback + 1));
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
      if (!this.interactive) throw new CliError(t('prompt.invalidChoice', { answer }));
      this.#io.stdout.write(`${t('prompt.chooseRange', { count: options.length })}\n`);
    }
  }

  close(): void {
    this.#rl.close();
  }

  async #read(question: string, secret = false): Promise<string> {
    if (this.interactive) {
      this.#rl.setPrompt(question);
      this.#rl.prompt();
      if (secret) this.#mute?.mute();
    }
    try {
      const next = await this.#lines.next();
      if (this.#interrupted) throw new CliError(t('prompt.cancelled'), undefined, EXIT.interrupted);
      if (next.done) {
        throw new CliError(t('prompt.inputEnded'), t('prompt.inputEnded.hint'));
      }
      return next.value;
    } finally {
      if (secret && this.#mute) {
        this.#mute.unmute();
        // 静音期间回车的换行没有输出。
        this.#io.stdout.write('\n');
      }
    }
  }
}
