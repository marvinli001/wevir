import { WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode, type QuestionRequest, type SessionId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  answerErrorKey,
  isBusy,
  messageContent,
  questionAnswers,
  questionsComplete,
  SessionActions,
  sendErrorKey,
} from './session-actions';
import type { SessionClient } from './session-watch';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

function client(results: Record<string, unknown> = {}, canWrite = true) {
  const calls: { method: string; params: unknown }[] = [];
  const fake: SessionClient = {
    canWrite,
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      const result = results[method];
      if (result instanceof Error) throw result;
      return result ?? {};
    }) as never,
    subscribe: vi.fn() as never,
  };
  return { fake, calls };
}

function rpcError(name: keyof typeof ErrorCode, data?: unknown): WevirRpcError {
  return new WevirRpcError('session.send', { code: ErrorCode[name], message: name, data });
}

const random = (n: number) => new Uint8Array(n).fill(7);

function question(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: 'qst_01JA2B3C4D5E6F7G8H9JKMNPQR',
    sessionId: SES,
    turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR',
    status: 'pending',
    createdAt: '2026-10-27T10:00:00.000Z',
    questions: [
      {
        id: 'db',
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        allowOther: true,
      },
      {
        id: 'targets',
        question: 'Platforms?',
        options: [{ label: 'iOS' }, { label: 'Android' }],
        multiSelect: true,
      },
    ],
    ...overrides,
  } as QuestionRequest;
}

describe('session actions', () => {
  it('sends text with an idempotency key, and the delivery only while a turn runs', async () => {
    const { fake, calls } = client();
    const actions = new SessionActions(fake, SES, random);
    await actions.send({ text: 'hi' });
    await actions.send({ text: 'and this', delivery: 'queue' });
    expect(calls[0]).toEqual({
      method: 'session.send',
      params: {
        sessionId: SES,
        content: [{ type: 'text', text: 'hi' }],
        clientMessageId: `m-${'07'.repeat(12)}`,
      },
    });
    expect(calls[1]?.params).toMatchObject({ delivery: 'queue' });
  });

  it('puts images before the text and skips empty messages', async () => {
    const image = {
      type: 'image' as const,
      imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR',
      mimeType: 'image/jpeg' as const,
      size: 10,
    };
    expect(messageContent('  ', [image as never])).toEqual([image]);
    expect(messageContent('look', [image as never])).toEqual([
      image,
      { type: 'text', text: 'look' },
    ]);
    const { fake, calls } = client();
    await new SessionActions(fake, SES, random).send({ text: ' ' });
    expect(calls).toEqual([]);
  });

  it('reads the default delivery from the host settings, steer when it cannot', async () => {
    const queue = client({ 'settings.get': { settings: { sendWhileBusy: 'queue' } } });
    expect(await new SessionActions(queue.fake, SES, random).defaultDelivery()).toBe('queue');
    const failing = client({ 'settings.get': new Error('offline') });
    expect(await new SessionActions(failing.fake, SES, random).defaultDelivery()).toBe('steer');
  });

  it('interrupts, cancels a pending message, renames, archives and uploads', async () => {
    const { fake, calls } = client({ 'image.upload': { image: { type: 'image' } } });
    const actions = new SessionActions(fake, SES, random);
    await actions.interrupt();
    await actions.cancelPending('pnd_1' as never);
    await actions.rename('New title');
    await actions.archive(true);
    expect(await actions.uploadImage('image/jpeg', 'AAAA')).toEqual({ type: 'image' });
    expect(calls).toEqual([
      { method: 'session.cancel', params: { sessionId: SES } },
      { method: 'pending.cancel', params: { sessionId: SES, pendingId: 'pnd_1' } },
      { method: 'session.rename', params: { sessionId: SES, title: 'New title' } },
      { method: 'session.archive', params: { sessionId: SES, archived: true } },
      { method: 'image.upload', params: { mimeType: 'image/jpeg', data: 'AAAA' } },
    ]);
  });

  it('knows when a turn is running', () => {
    expect(isBusy(undefined)).toBe(false);
    expect(isBusy({ state: 'idle' })).toBe(false);
    expect(isBusy({ state: 'running' })).toBe(true);
    expect(isBusy({ state: 'awaiting_approval' })).toBe(true);
    expect(isBusy({ activeTurnId: 'trn_1', state: 'idle' })).toBe(true);
  });

  it('explains failures, with device permissions as computer-only', () => {
    expect(sendErrorKey(rpcError('DEVICE_FORBIDDEN', { missing: ['session.write'] }))).toBe(
      'error.computerOnly',
    );
    expect(sendErrorKey(rpcError('SESSION_BUSY'))).toBe('session.busy');
    expect(
      sendErrorKey(
        rpcError('INVALID_STATE', {
          state: 'idle',
          readOnly: {
            reason: 'engine_session_not_found',
            message: 'gone',
            since: '2026-10-27T10:00:00.000Z',
          },
        }),
      ),
    ).toBe('session.readOnly');
    expect(sendErrorKey(new Error('x'))).toBe('session.sendFailed');
    expect(answerErrorKey(rpcError('QUESTION_NOT_FOUND'))).toBe('question.handled');
    expect(answerErrorKey(new Error('x'))).toBe('question.failed');
  });
});

describe('question answers', () => {
  it('maps picked options and typed text to answers', () => {
    const request = question();
    const answers = questionAnswers(
      request,
      { db: ['SQLite'], targets: ['iOS', 'Android', 'Windows'] },
      { db: '', targets: '' },
    );
    expect(answers).toEqual({
      db: { answers: ['SQLite'] },
      targets: { answers: ['iOS', 'Android'] },
    });
    expect(questionsComplete(request, answers)).toBe(true);
  });

  it('lets typed text replace a single choice and skips unanswered questions', () => {
    const request = question();
    const answers = questionAnswers(request, { db: ['SQLite'] }, { db: '  DuckDB ' });
    expect(answers).toEqual({ db: { answers: ['DuckDB'] } });
    expect(questionsComplete(request, answers)).toBe(false);
  });
});
