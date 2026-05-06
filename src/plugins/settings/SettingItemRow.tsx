// 单个设置项的通用渲染器(M-Settings v6)。
// 根据 SettingItemSpec.type 自动选 UI:
//   boolean → SegmentedControl(启用/禁用)
//   select  → SegmentedControl(spec.enum)
//   number  → Input type=number(min/max/step 透传)
//   text    → Input type=text
//
// 一行结构:title + description 在上,控件靠右。

import { Input, SegmentedControl } from '@/design';
import type { SettingItemSpec } from '../registries/SettingItemRegistry';
import { useSettingsValuesStore } from './values-store';

interface SettingItemRowProps {
  readonly spec: SettingItemSpec;
}

const BOOLEAN_OPTIONS = [
  { id: 'true', label: '启用' },
  { id: 'false', label: '禁用' },
] as const;

export function SettingItemRow({ spec }: SettingItemRowProps) {
  const value = useSettingsValuesStore(
    (s) => s.values[spec.id] ?? spec.default,
  );
  const setValue = useSettingsValuesStore((s) => s.setValue);

  return (
    <div className="flex items-start justify-between gap-6 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-fg">{spec.title}</div>
        {spec.description && (
          <div className="mt-0.5 text-[11px] text-fg-dim">
            {spec.description}
          </div>
        )}
        <div className="mt-0.5 text-[10px] uppercase tracking-wider text-fg-dim/60">
          {spec.id}
        </div>
      </div>
      <div className="shrink-0">
        {spec.type === 'boolean' && (
          <SegmentedControl
            size="sm"
            options={BOOLEAN_OPTIONS}
            value={String(Boolean(value)) as 'true' | 'false'}
            onChange={(id) => setValue(spec.id, id === 'true')}
          />
        )}
        {spec.type === 'select' && spec.enum && (
          <SegmentedControl
            size="sm"
            options={spec.enum.map((o) => ({ id: o.value, label: o.label }))}
            value={String(value)}
            onChange={(id) => setValue(spec.id, id)}
          />
        )}
        {spec.type === 'number' && (
          <Input
            type="number"
            size="sm"
            value={String(value)}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            onChange={(e) => {
              const n = Number((e.target as HTMLInputElement).value);
              if (!Number.isFinite(n)) return;
              setValue(spec.id, n);
            }}
            className="w-24"
          />
        )}
        {spec.type === 'text' && (
          <Input
            type="text"
            size="sm"
            value={String(value)}
            onChange={(e) =>
              setValue(spec.id, (e.target as HTMLInputElement).value)
            }
            className="w-48"
          />
        )}
      </div>
    </div>
  );
}
