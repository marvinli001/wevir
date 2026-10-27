// 会话页上能做的事（M2）：发消息（回合进行中插话或排队，照桌面的“回合进行中按回车”）、中断、取消排队的消息、回答提问、改名、
// 归档、上传照片。全部是隧道里的 JSON-RPC，连接由调用方注入（`SessionClient`），测试用假的。纯逻辑。

import { isRpcError } from '@wevir/client-sdk';
import type {
  PendingDelivery,
  PendingMessageId,
  QuestionAnswer,
  QuestionId,
  QuestionRequest,
  SessionId,
  UserContentPart,
  UserImageMimeType,
  UserImagePart,
} from '@wevir/protocol';
import type { MessageKey } from '../i18n';
import type { SessionClient } from './session-watch';

/** 回合在跑：这时发出的消息要说明是插话还是排队。 */
export function isBusy(view: { activeTurnId?: unknown; state?: string } | undefined): boolean {
  if (view === undefined) return false;
  if (view.activeTurnId !== undefined) return true;
  return (
    view.state === 'running' || view.state === 'awaiting_approval' || view.state === 'cancelling'
  );
}

/** 一条消息的内容：先图片后文字（同桌面）。只有空白的文字不带。 */
export function messageContent(
  text: string,
  images: readonly UserImagePart[] = [],
): UserContentPart[] {
  const parts: UserContentPart[] = [...images];
  if (text.trim() !== '') parts.push({ type: 'text', text });
  return parts;
}

/** 幂等键：同一条消息重发时 Host 认得出来。 */
export function clientMessageId(random: (n: number) => Uint8Array): string {
  return `m-${Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 发出失败时给界面的一句话。 */
export function sendErrorKey(error: unknown): MessageKey {
  if (isRpcError(error, 'DEVICE_FORBIDDEN')) return 'error.computerOnly';
  if (isRpcError(error, 'SESSION_BUSY')) return 'session.busy';
  if (isRpcError(error, 'INVALID_STATE') && error.data?.readOnly !== undefined)
    return 'session.readOnly';
  return 'session.sendFailed';
}

/** 回答提问时给界面的一句话：已在别处回答、已取消算“已处理”。 */
export function answerErrorKey(error: unknown): MessageKey {
  if (isRpcError(error, 'DEVICE_FORBIDDEN')) return 'error.computerOnly';
  if (isRpcError(error, 'QUESTION_NOT_FOUND') || isRpcError(error, 'ALREADY_DECIDED'))
    return 'question.handled';
  return 'question.failed';
}

/**
 * 界面上的作答（每个问题选中的选项与自己填的）换成 `question.respond` 的 `answers`：选项按 `label`，填的去掉首尾空白追加在后；
 * 单选题填了就只用填的。什么都没答的问题省略（当作跳过）。
 */
export function questionAnswers(
  request: QuestionRequest,
  picked: Readonly<Record<string, readonly string[]>>,
  typed: Readonly<Record<string, string>>,
): Record<string, QuestionAnswer> {
  const out: Record<string, QuestionAnswer> = {};
  for (const question of request.questions) {
    const own = typed[question.id]?.trim() ?? '';
    const labels = (picked[question.id] ?? []).filter((label) =>
      question.options.some((option) => option.label === label),
    );
    const answers = question.multiSelect
      ? [...labels, ...(own !== '' ? [own] : [])]
      : own !== ''
        ? [own]
        : labels.slice(0, 1);
    if (answers.length > 0) out[question.id] = { answers };
  }
  return out;
}

/** 每个问题都答了（单选选了或填了，多选至少一项）才能提交。 */
export function questionsComplete(
  request: QuestionRequest,
  answers: Readonly<Record<string, QuestionAnswer>>,
): boolean {
  return request.questions.every((question) => (answers[question.id]?.answers.length ?? 0) > 0);
}

export interface SendOptions {
  text: string;
  images?: readonly UserImagePart[];
  /** 回合进行中时：插话或排队。空闲时不带。 */
  delivery?: PendingDelivery;
}

export class SessionActions {
  readonly #client: SessionClient;
  readonly #sessionId: SessionId;
  readonly #random: (n: number) => Uint8Array;

  constructor(client: SessionClient, sessionId: SessionId, random: (n: number) => Uint8Array) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#random = random;
  }

  /** 这台设备能发消息、中断、回答（`session.write`）。 */
  get canWrite(): boolean {
    return this.#client.canWrite;
  }

  /** Host 设置里“回合进行中按回车”的默认方式；读不到时插话（Host 的默认值）。 */
  async defaultDelivery(): Promise<PendingDelivery> {
    try {
      const { settings } = await this.#client.request('settings.get', {});
      return settings.sendWhileBusy;
    } catch {
      return 'steer';
    }
  }

  async send({ text, images, delivery }: SendOptions): Promise<void> {
    const content = messageContent(text, images);
    if (content.length === 0) return;
    await this.#client.request('session.send', {
      sessionId: this.#sessionId,
      content,
      clientMessageId: clientMessageId(this.#random),
      ...(delivery !== undefined && { delivery }),
    });
  }

  async interrupt(): Promise<void> {
    await this.#client.request('session.cancel', { sessionId: this.#sessionId });
  }

  async cancelPending(pendingId: PendingMessageId): Promise<void> {
    await this.#client.request('pending.cancel', { sessionId: this.#sessionId, pendingId });
  }

  async answer(questionId: QuestionId, answers: Record<string, QuestionAnswer>): Promise<void> {
    await this.#client.request('question.respond', { questionId, answers });
  }

  async rename(title: string): Promise<void> {
    await this.#client.request('session.rename', { sessionId: this.#sessionId, title });
  }

  async archive(archived: boolean): Promise<void> {
    await this.#client.request('session.archive', { sessionId: this.#sessionId, archived });
  }

  /** 上传一张照片（base64），拿到能放进消息的图片部件。 */
  async uploadImage(mimeType: UserImageMimeType, data: string): Promise<UserImagePart> {
    const { image } = await this.#client.request('image.upload', { mimeType, data });
    return image;
  }
}
