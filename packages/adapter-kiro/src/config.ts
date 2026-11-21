import { AdapterError, type CollaborationMode, type SessionConfig } from '@wevir/runtime-adapter';
import { fromKiroEffort, kiroSelectOption, modelOption } from './models.js';

// Kiro can publish the new model and its effort in a separate update after the write.
const CONFIG_UPDATE_TIMEOUT_MS = 2000;
const PLAN_MODES = ['plan', 'kiro_planner'];
const DEFAULT_MODES = ['default', 'vibe', 'kiro_default'];

export interface KiroConfigAccess {
  read(): unknown;
  waitFor(predicate: (value: unknown) => boolean, timeoutMs: number): Promise<unknown>;
  set(id: string, value: string): Promise<void>;
}

export function kiroEffortValue(configOptions: unknown): string | undefined {
  const value = kiroSelectOption(configOptions, 'effortLevel')?.currentValue;
  return value !== undefined && value !== 'default' ? fromKiroEffort(value) : undefined;
}

export async function applyKiroEffort(
  access: KiroConfigAccess,
  engineModelId: string | undefined,
  effort: string | undefined,
): Promise<void> {
  if (effort === undefined) return;
  const requested = fromKiroEffort(effort);
  const matches = (options: unknown) =>
    (engineModelId === undefined || modelOption(options)?.currentValue === engineModelId) &&
    kiroSelectOption(options, 'effortLevel') !== undefined;
  const options = await readConfig(access, matches);
  if (!matches(options)) return;
  const option = kiroSelectOption(options, 'effortLevel');
  if (option === undefined || kiroEffortValue(options) === requested) return;
  const advertised = option.values.find((value) => fromKiroEffort(value) === requested);
  if (advertised !== undefined) await access.set(option.id, advertised);
}

export function kiroAllowsUnattended(
  config: Pick<SessionConfig, 'permissionMode' | 'engineTools'>,
  collaborationMode?: CollaborationMode,
): boolean {
  const tools = config.engineTools;
  return (
    config.permissionMode === 'full_access' &&
    collaborationMode !== 'plan' &&
    !tools?.denied.length &&
    !tools?.deniedNames.length &&
    tools?.allowedNames === undefined
  );
}

export async function applyKiroAutopilot(
  access: KiroConfigAccess,
  config: Pick<SessionConfig, 'permissionMode' | 'engineTools'>,
  collaborationMode?: CollaborationMode,
): Promise<void> {
  const unattended = kiroAllowsUnattended(config, collaborationMode);
  const options = unattended
    ? access.read()
    : await readConfig(access, (value) => kiroSelectOption(value, 'autopilot') !== undefined);
  const option = kiroSelectOption(options, 'autopilot');
  const target = unattended ? 'on' : 'off';
  if (option?.currentValue === target) return;
  if (option?.values.includes(target)) await access.set(option.id, target);
  if (unattended) return;
  const supervised = (value: unknown) =>
    kiroSelectOption(value, 'autopilot')?.currentValue === 'off';
  if (!option?.values.includes(target) || !supervised(await readConfig(access, supervised))) {
    throw new AdapterError('engine_unavailable', 'Kiro did not confirm supervised mode.');
  }
}

export function kiroModeOption(options: unknown) {
  return kiroSelectOption(options, 'mode');
}

export function kiroSupportsPlan(options: unknown): boolean {
  const mode = kiroModeOption(options);
  return mode !== undefined && PLAN_MODES.some((id) => mode.values.includes(id));
}

export function kiroAgentIds(options: unknown): string[] {
  return kiroModeOption(options)?.values.filter((id) => !PLAN_MODES.includes(id)) ?? [];
}

export async function selectKiroAgent(access: KiroConfigAccess, modeId: string): Promise<void> {
  const getMode = (options: unknown) => kiroModeOption(options) !== undefined;
  const options = await readConfig(access, getMode);
  if (!kiroAgentIds(options).includes(modeId)) {
    throw new AdapterError('invalid_input', 'Kiro does not offer that agent mode.');
  }
  await setKiroMode(access, modeId);
}

export async function applyKiroMode(
  access: KiroConfigAccess,
  collaborationMode: CollaborationMode | undefined,
  priorMode?: string,
): Promise<string | undefined> {
  const planning = collaborationMode === 'plan';
  const options = planning
    ? await readConfig(access, (value) => kiroModeOption(value) !== undefined)
    : access.read();
  const mode = kiroModeOption(options);
  const inPlan = mode?.currentValue !== undefined && PLAN_MODES.includes(mode.currentValue);
  if (planning && inPlan) return priorMode;
  if (!planning && !inPlan) return undefined;
  const requested = planning
    ? PLAN_MODES.find((id) => mode?.values.includes(id))
    : priorMode !== undefined && mode?.values.includes(priorMode)
      ? priorMode
      : DEFAULT_MODES.find((id) => mode?.values.includes(id));
  if (mode === undefined || requested === undefined) {
    throw new AdapterError(
      'invalid_input',
      planning ? 'Kiro does not offer Plan mode.' : 'Kiro does not offer a default agent mode.',
    );
  }
  await setKiroMode(access, requested);
  return planning ? mode.currentValue : undefined;
}

async function setKiroMode(access: KiroConfigAccess, requested: string): Promise<void> {
  if (kiroModeOption(access.read())?.currentValue === requested) return;
  await access.set('mode', requested);
  const changed = (value: unknown) => kiroModeOption(value)?.currentValue === requested;
  if (!changed(await readConfig(access, changed))) {
    throw new AdapterError(
      'engine_unavailable',
      `Kiro did not select the ${requested} agent mode.`,
    );
  }
}

async function readConfig(
  access: KiroConfigAccess,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  const current = access.read();
  return predicate(current) ? current : access.waitFor(predicate, CONFIG_UPDATE_TIMEOUT_MS);
}
