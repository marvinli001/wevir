import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WevirClient } from '@wevir/client-sdk';
import type { PermissionMode } from '@wevir/protocol';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { type Context, connect, workspacePath } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { t } from '../i18n/index.js';
import { readStdin } from '../prompt.js';
import { hostStart, readRuntime } from './host.js';
import { pickProvider } from './session.js';

export interface ExecOptions {
  cwd?: string;
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
  json?: boolean;
  outputSchema?: string;
}

async function outputValidator(ctx: Context, file: string): Promise<ValidateFunction> {
  try {
    const schema = JSON.parse(await readFile(resolve(ctx.io.cwd, file), 'utf8')) as AnySchema;
    const draft = typeof schema === 'object' && schema !== null ? schema.$schema : undefined;
    const Validator =
      draft === 'https://json-schema.org/draft/2020-12/schema'
        ? Ajv2020
        : draft === 'https://json-schema.org/draft/2019-09/schema'
          ? Ajv2019
          : Ajv;
    const ajv = new Validator({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    if ('$async' in validate && validate.$async) throw new Error(t('exec.asyncSchema'));
    return validate;
  } catch (error) {
    throw new UsageError(
      t('exec.badSchema', { file, error: (error as Error).message }),
      t('usage.seeCommandHelp', { command: 'exec' }),
    );
  }
}

export async function exec(ctx: Context, input: string, options: ExecOptions): Promise<number> {
  const prompt = input === '-' ? await readStdin(ctx.io) : input;
  if (prompt.trim() === '') throw new UsageError(t('exec.emptyPrompt'));
  const validate =
    options.outputSchema === undefined
      ? undefined
      : await outputValidator(ctx, options.outputSchema);
  let client: WevirClient;
  try {
    client = await connect(ctx);
  } catch (error) {
    const runtime = await readRuntime(ctx.home);
    if (runtime.kind === 'live' || runtime.kind === 'invalid') throw error;
    await hostStart({ ...ctx, print: (text = '') => ctx.io.stderr.write(`${text}\n`) }, {});
    client = await connect(ctx);
  }
  try {
    const { workspace } = await client.request('workspace.add', {
      rootPath: workspacePath(ctx, options.cwd ?? ctx.io.cwd),
    });
    const { providers } = await client.request('provider.list');
    const provider = pickProvider(providers, options.provider);
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: provider.id,
      ...(options.model !== undefined && { modelId: options.model }),
      ...(options.permissionMode !== undefined && { permissionMode: options.permissionMode }),
    });
    const subscription = client.subscribe(session.id);
    let stopCode: number | undefined;
    let cancellation: Promise<void> | undefined;
    let connectionError: Error | undefined;
    let cancellationError: unknown;
    let sent = false;
    const cancel = (): Promise<void> => {
      cancellation ??= client.request('session.cancel', { sessionId: session.id }).then(
        () => {},
        (error: unknown) => {
          cancellationError = error;
          subscription.close();
        },
      );
      return cancellation;
    };
    const offInterrupt = ctx.io.onInterrupt(() => {
      stopCode ??= EXIT.interrupted;
      if (sent) void cancel();
    });
    const offState = client.onStateChange((state) => {
      if (state.status === 'reconnecting' || state.status === 'closed') {
        connectionError = new CliError(
          t('exec.disconnected'),
          t('exec.sessionHint', { id: session.id }),
        );
        subscription.close();
      }
    });
    try {
      if (stopCode !== undefined) return stopCode;
      sent = true;
      const { turnId } = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: prompt }],
      });
      if (turnId === undefined) throw new CliError(t('exec.noTurn'));
      let answer: string | undefined;
      let failure: string | undefined;
      for await (const item of subscription) {
        if (item.type === 'reset') throw new CliError(t('exec.disconnected'));
        if (item.type !== 'event') continue;
        const event = item.event;
        if (options.json) ctx.print(JSON.stringify(event));
        switch (event.type) {
          case 'assistant.message':
            if (event.payload.turnId === turnId) answer = event.payload.text;
            break;
          case 'engine.error':
            if (event.payload.turnId === undefined || event.payload.turnId === turnId) {
              failure = event.payload.message;
            }
            break;
          case 'approval.requested': {
            if (event.payload.approval.turnId !== turnId || stopCode !== undefined) break;
            // Host 的规则和 hooks 可能已处理请求；只取消仍需人工处理的审批。
            const { pendingApprovals } = await client.request('session.get', {
              sessionId: session.id,
            });
            const approval = pendingApprovals.find((a) => a.id === event.payload.approval.id);
            if (!approval) break;
            stopCode = EXIT.inputRequired;
            ctx.printError(
              new CliError(
                t('exec.approvalRequired', {
                  id: approval.id,
                  summary: approval.detail?.toolName ?? approval.toolCallId,
                }),
                t('exec.sessionHint', { id: session.id }),
              ),
            );
            await cancel();
            break;
          }
          case 'question.requested': {
            const { question } = event.payload;
            if (question.turnId !== turnId || question.async || stopCode !== undefined) break;
            const { pendingQuestions } = await client.request('session.get', {
              sessionId: session.id,
            });
            if (!pendingQuestions?.some((q) => q.id === question.id)) break;
            stopCode = EXIT.inputRequired;
            ctx.printError(
              new CliError(
                t('exec.questionRequired', { id: question.id }),
                t('exec.sessionHint', { id: session.id }),
              ),
            );
            await cancel();
            break;
          }
          case 'turn.finished': {
            if (event.payload.turnId !== turnId) break;
            await cancellation;
            if (cancellationError) throw cancellationError;
            if (!options.json && answer !== undefined) ctx.print(answer);
            if (stopCode !== undefined) return stopCode;
            if (event.payload.outcome === 'cancelled') return EXIT.interrupted;
            if (event.payload.outcome !== 'completed') {
              throw new CliError(
                failure ?? t('exec.failed'),
                t('exec.sessionHint', { id: session.id }),
              );
            }
            if (validate !== undefined) {
              let value: unknown;
              try {
                value = JSON.parse(answer ?? '');
              } catch {
                throw new CliError(t('exec.invalidJson'), undefined, EXIT.invalidOutput);
              }
              if (!validate(value)) {
                throw new CliError(
                  t('exec.invalidOutput', {
                    error: new Ajv().errorsText(validate.errors, { separator: '; ' }),
                  }),
                  undefined,
                  EXIT.invalidOutput,
                );
              }
            }
            return EXIT.ok;
          }
        }
      }
      if (cancellationError) throw cancellationError;
      throw connectionError ?? new CliError(t('exec.noResult'));
    } finally {
      offInterrupt();
      offState();
      subscription.close();
      await cancellation;
    }
  } finally {
    client.close();
  }
}
