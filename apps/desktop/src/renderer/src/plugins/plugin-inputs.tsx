// 插件输入项的一行（0.42.0）：插件详情里改已装插件的输入项、“添加”对话框里装新插件前填输入项，共用同一种行。

import { type ReactNode, useId } from 'react';
import { Input } from '@/components/ui/input';

export interface InputSpec {
  key: string;
  label: string;
  description?: string | undefined;
  secret: boolean;
  required: boolean;
}

/** 标签（必填加星号）、输入框（密钥项不回显）、右边可放操作（清除），下面是清单里写的说明。 */
export function InputField({
  spec,
  value,
  placeholder,
  onChange,
  action,
}: {
  spec: InputSpec;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-1 text-sm">
        {spec.label}
        {spec.required && (
          <span aria-hidden className="text-muted-foreground">
            *
          </span>
        )}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={spec.secret ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          aria-required={spec.required || undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className={action ? 'pr-8' : undefined}
          data-input-key={spec.key}
        />
        {action && <div className="absolute inset-y-0 right-1 flex items-center">{action}</div>}
      </div>
      {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
    </div>
  );
}
