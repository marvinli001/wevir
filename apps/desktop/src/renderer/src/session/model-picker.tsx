import type { ProviderModel, ProviderProfile } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type PlainMessageKey, t } from '@/i18n';
import { providerLogo } from '@/settings/provider-catalog';
import { DSH_DEEPSEEK_MODELS } from '@/settings/provider-presets';

/** 选中的模型：哪个 Provider 的哪个模型，推理档位（省略表示模型的默认档位）。 */
export interface ModelChoice {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
}

/** Provider 能选的模型：DeepSeek 官方没列模型时是 dsh 自带的目录（providers.md §2.2）。 */
export function modelsOf(provider: ProviderProfile): ProviderModel[] {
  if (provider.models.length > 0) return provider.models;
  return DSH_DEEPSEEK_MODELS.map((id) => ({ id }));
}

function modelName(model: ProviderModel | undefined, fallback: string): string {
  return model?.displayName ?? model?.id ?? fallback;
}

const EFFORT_LABELS: Record<string, PlainMessageKey> = {
  off: 'subagent.effort.off',
  minimal: 'subagent.effort.minimal',
  low: 'subagent.effort.low',
  medium: 'subagent.effort.medium',
  high: 'subagent.effort.high',
  xhigh: 'subagent.effort.xhigh',
  max: 'subagent.effort.max',
};

export function effortLabel(effort: string | undefined): string {
  if (effort === undefined) return t('model.effort.default');
  const key = EFFORT_LABELS[effort];
  return key ? t(key) : effort;
}

/**
 * 输入框右下角的模型选择（U8，照 Codex 桌面端）：芯片写着模型与思考力度；点开是思考力度的滑块，点模型名换到模型列表。
 * 新会话（首页、草稿页）能在全部 Provider 的模型里选；已有会话 `lockProvider`，只在它的 Provider 里换（协议 0.9.0 的
 * `session.configure`，Host 不支持时 `readOnly`，只显示）。
 */
export function ModelPicker({
  providers,
  value,
  lockProvider = false,
  readOnly = false,
  onChange,
}: {
  providers: readonly ProviderProfile[];
  value: ModelChoice;
  lockProvider?: boolean;
  readOnly?: boolean;
  onChange: (next: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const provider = providers.find((candidate) => candidate.id === value.providerId);
  const model = provider && modelsOf(provider).find((candidate) => candidate.id === value.modelId);
  const efforts = model?.reasoningEfforts ?? [];
  const name = modelName(model, value.modelId);

  const chip = (
    <>
      <span className="truncate">{name}</span>
      {efforts.length > 0 && (
        <span className="shrink-0 text-muted-foreground">{effortLabel(value.reasoningEffort)}</span>
      )}
    </>
  );
  const chipClass =
    'inline-flex h-7 max-w-64 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-soft-foreground outline-none transition-colors duration-150';

  if (readOnly) {
    return (
      <span className={chipClass} data-testid="model-picker">
        {chip}
      </span>
    );
  }

  const choose = (next: ModelChoice) => {
    onChange(next);
    setView('effort');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView('effort');
      }}
    >
      <PopoverTrigger
        data-testid="model-picker"
        aria-label={t('model.picker.label', { model: name })}
        className={cn(
          chipClass,
          'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        )}
      >
        {chip}
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 gap-0 p-0">
        {view === 'effort' ? (
          <div className="flex flex-col gap-3 p-3 animate-in duration-150 fade-in">
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 pl-8">
                <p className="text-base font-semibold" data-testid="model-picker-effort">
                  {efforts.length > 0
                    ? effortLabel(value.reasoningEffort)
                    : t('model.effort.fixed')}
                </p>
                <button
                  type="button"
                  onClick={() => setView('models')}
                  className="inline-flex max-w-full items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  data-action="choose-model"
                >
                  <span className="truncate">{name}</span>
                  <ChevronRight aria-hidden className="size-3.5 shrink-0" />
                </button>
              </div>
              <IconButton
                label={t('model.effort.reset')}
                size="icon-xs"
                className="text-muted-foreground"
                disabled={value.reasoningEffort === undefined}
                onClick={() => {
                  const { reasoningEffort: _cleared, ...rest } = value;
                  onChange(rest);
                }}
              >
                <RotateCcw />
              </IconButton>
            </div>
            {efforts.length > 0 && (
              <EffortSlider
                efforts={efforts}
                value={value.reasoningEffort}
                onChange={(effort) => onChange({ ...value, reasoningEffort: effort })}
              />
            )}
          </div>
        ) : (
          <ModelList
            providers={lockProvider && provider ? [provider] : providers}
            value={value}
            onBack={() => setView('effort')}
            onChoose={(providerId, next) =>
              choose(
                next.id === value.modelId && providerId === value.providerId
                  ? value
                  : { providerId, modelId: next.id },
              )
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModelList({
  providers,
  value,
  onBack,
  onChoose,
}: {
  providers: readonly ProviderProfile[];
  value: ModelChoice;
  onBack: () => void;
  onChoose: (providerId: string, model: ProviderModel) => void;
}) {
  return (
    <div className="flex max-h-96 flex-col animate-in duration-150 fade-in slide-in-from-right-2">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <IconButton label={t('model.picker.back')} size="icon-xs" onClick={onBack}>
          <ChevronLeft />
        </IconButton>
        <span className="text-xs font-medium text-muted-foreground">
          {t('model.picker.select')}
        </span>
      </div>
      <div className="overflow-y-auto p-1.5">
        {providers.map((provider) => (
          <section key={provider.id} className="pb-1 last:pb-0">
            <h3 className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
              <ProviderLogo
                logo={providerLogo(provider)}
                fallback={provider.displayName}
                className="size-3.5"
              />
              {provider.displayName}
            </h3>
            <ul>
              {modelsOf(provider).map((model) => {
                const selected = provider.id === value.providerId && model.id === value.modelId;
                return (
                  <li key={model.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      data-model-id={model.id}
                      onClick={() => onChoose(provider.id, model)}
                      className={cn(
                        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:bg-muted',
                        selected && 'font-medium',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{modelName(model, model.id)}</span>
                      {selected && <Check aria-hidden className="size-4 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * 思考力度的滑块：每一档是一个停靠点，已选的一段是墨色，圆钮停在当前档（没选时在最左、填充为空）。点、拖与方向键都能换。
 */
function EffortSlider({
  efforts,
  value,
  onChange,
}: {
  efforts: readonly string[];
  value: string | undefined;
  onChange: (effort: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const index = value === undefined ? -1 : efforts.indexOf(value);
  const last = Math.max(1, efforts.length - 1);
  const position = index < 0 ? 0 : index / last;

  const pick = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - 12) / (rect.width - 24)));
    const next = efforts[Math.round(ratio * last)];
    if (next !== undefined && next !== value) onChange(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pick(event.clientX);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next =
      efforts[Math.min(efforts.length - 1, Math.max(0, (index < 0 ? -1 : index) + step))];
    if (next !== undefined && next !== value) onChange(next);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={t('model.effort.label')}
      aria-valuemin={0}
      aria-valuemax={efforts.length - 1}
      aria-valuenow={Math.max(0, index)}
      aria-valuetext={effortLabel(value)}
      data-testid="effort-slider"
      onPointerDown={onPointerDown}
      onPointerMove={(event) => event.buttons === 1 && pick(event.clientX)}
      onKeyDown={onKeyDown}
      className="relative h-7 cursor-pointer touch-none rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-full bg-foreground/85 transition-[width] duration-200 ease-out"
        style={{ width: index < 0 ? 0 : `calc(${position} * (100% - 1.75rem) + 1.75rem)` }}
      />
      {efforts.map((effort, stop) => (
        <span
          key={effort}
          aria-hidden
          className={cn(
            'absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors',
            stop <= index ? 'bg-background/70' : 'bg-muted-foreground/60',
          )}
          style={{ left: `calc(${stop / last} * (100% - 1.75rem) + 0.875rem)` }}
        />
      ))}
      <span
        aria-hidden
        className="absolute top-0.5 size-6 rounded-full bg-card shadow-sm ring-1 ring-border transition-[left] duration-200 ease-out"
        style={{ left: `calc(${position} * (100% - 1.75rem) + 0.125rem)` }}
      />
    </div>
  );
}
