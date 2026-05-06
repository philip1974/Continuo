// 单个设置项的通用渲染器(M-Settings v6 / UI polish)。
// 视觉对齐 demo(Industrial IDE Dark):
//   - title 后 inline id chip(浅底 uppercase),取代独占一行
//   - boolean → toggle switch(滑块,占空间小)
//   - select  → SegmentedControl(spec.enum)
//   - number  → Input + 单位 chip(右侧)
//   - text    → Input
//   - reset   → 始终占位的 ↺,override 时可见

import { IconButton, Input, SegmentedControl } from '@/design';
import type { SettingItemSpec } from '../registries/SettingItemRegistry';
import { useSettingsValuesStore } from './values-store';

interface SettingItemRowProps {
  readonly spec: SettingItemSpec;
}

export function SettingItemRow({ spec }: SettingItemRowProps) {
  const stored = useSettingsValuesStore((s) => s.values[spec.id]);
  const setValue = useSettingsValuesStore((s) => s.setValue);
  const reset = useSettingsValuesStore((s) => s.reset);
  const value = stored ?? spec.default;
  // values 中存在 override → 显示 reset;undefined 表示走 default,无需 reset
  const isOverridden = stored !== undefined;

  return (
    <div className="flex items-start justify-between gap-6 border-b border-line/50 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-fg">{spec.title}</span>
          {/* id chip:demo 同款浅底 uppercase 紧贴 title 显示,取代独占一行 */}
          <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted/70">
            {spec.id}
          </code>
        </div>
        {spec.description && (
          <div className="mt-1 text-xs text-fg-muted">{spec.description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {spec.type === 'boolean' && (
          <ToggleSwitch
            checked={Boolean(value)}
            onChange={(v) => setValue(spec.id, v)}
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
          <div className="flex items-center gap-1">
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
              className="w-24 text-right"
            />
            {spec.unit && (
              <span className="select-none rounded bg-panel-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-dim">
                {spec.unit}
              </span>
            )}
          </div>
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
        {/* 常驻占位避免 reset 时 Input 等控件位置跳动;非 override 状态下
         *  invisible + pointer-events-none 保留布局但不响应 */}
        <IconButton
          size="xs"
          onClick={() => isOverridden && reset(spec.id)}
          title={`恢复默认(${String(spec.default)})`}
          aria-label="恢复默认"
          className={isOverridden ? '' : 'pointer-events-none invisible'}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
            <path d="M13 3v3h-3" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}

// ── 内嵌业务级 toggle switch(design system 暂无,且仅在 Settings 用)──
// 真要 native:design system 没有 Toggle 组件,SegmentedControl「启用/禁用」
// 视觉太重占位多;这里写一个紧凑滑块沿用语义 token,不引入新 design 依赖。

interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}

function ToggleSwitch({ checked, onChange }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        checked ? 'bg-accent' : 'border border-line bg-panel-soft',
      ].join(' ')}
    >
      <span
        className={[
          'absolute h-2.5 w-2.5 rounded-full transition-transform',
          checked
            ? 'translate-x-[18px] bg-fg'
            : 'translate-x-1 bg-fg-muted',
        ].join(' ')}
      />
    </button>
  );
}
