// 单个设置项的通用渲染器(M-Settings v6 / UI polish)。
// 视觉对齐 demo(Industrial IDE Dark):
//   - title 后 inline id chip(浅底 uppercase),取代独占一行
//   - boolean → toggle switch(滑块,占空间小)
//   - select  → SegmentedControl(spec.enum)
//   - number  → Input + 单位 chip(右侧)
//   - text    → Input
//   - reset   → 始终占位的 ↺,override 时可见

import { useMemo, useState } from 'react';
import {
  IconButton,
  Input,
  SegmentedControl,
  type SegmentedControlOption,
} from '@/design';
import { useLocale, useT } from '@/i18n';
import {
  clampSettingNumber,
  SI_TEXT_VALUE_MAX,
  type SettingItemSpec,
  type SettingItemValue,
} from '../registries/SettingItemRegistry';
import { useSettingsValuesStore } from './values-store';

const SETTING_TOGGLE_SWITCH_BASE_CLASS_NAME =
  'relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';
const SETTING_TOGGLE_SWITCH_ON_CLASS_NAME =
  `${SETTING_TOGGLE_SWITCH_BASE_CLASS_NAME} bg-accent`;
const SETTING_TOGGLE_SWITCH_OFF_CLASS_NAME =
  `${SETTING_TOGGLE_SWITCH_BASE_CLASS_NAME} border border-line bg-panel-soft`;

const SETTING_TOGGLE_KNOB_BASE_CLASS_NAME =
  'absolute h-2.5 w-2.5 rounded-full transition-transform';
const SETTING_TOGGLE_KNOB_ON_CLASS_NAME =
  `${SETTING_TOGGLE_KNOB_BASE_CLASS_NAME} translate-x-[18px] bg-fg`;
const SETTING_TOGGLE_KNOB_OFF_CLASS_NAME =
  `${SETTING_TOGGLE_KNOB_BASE_CLASS_NAME} translate-x-1 bg-fg-muted`;
/** 把输入框文本解析成可提交的数字;空串 / 非有限数 → null。 */
function parseSettingNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * number 设置项输入框。键入中的文本先放在本地草稿里:范围内的值即时生效;越界的中间值(把 13 改成 16 时
 * 先出现的 "1")不钳制回写 —— 否则输入框被改成 min,后续按键拼在后面,永远输不进目标值。失焦 / Enter
 * 时才按 spec 钳制提交(E6:min/max 属性不阻止键入越界),并丢弃草稿回显实际值。
 */
function NumberSettingInput({
  spec,
  value,
  titleId,
  onCommit,
}: {
  spec: SettingItemSpec;
  value: SettingItemValue;
  titleId: string;
  onCommit: (n: number) => void;
}) {
  // 草稿记下它对应的「已知值」:键入范围内的值会立即提交(已知值 = 提交的数),越界的中间值不提交(已知值 =
  // 当时的值)。之后 value 若不再等于已知值,说明被别处改了(点了重置、别的窗口改了设置)→ 草稿作废,显示
  // 新值;否则键入的旧文本会一直遮住它。
  const [draftState, setDraftState] = useState<{ text: string; forValue: SettingItemValue } | null>(
    null,
  );
  const draft = draftState !== null && Object.is(draftState.forValue, value) ? draftState.text : null;
  const commitClamped = (raw: string): void => {
    // 没键入过(无有效草稿)→ 不提交:否则 Tab 经过 / 点一下就会写出一条等于当前值的 override。
    if (draft === null) {
      if (draftState !== null) setDraftState(null);
      return;
    }
    const n = parseSettingNumber(raw);
    if (n !== null) onCommit(clampSettingNumber(spec, n));
    setDraftState(null);
  };
  return (
    <Input
      type="number"
      size="sm"
      aria-labelledby={titleId}
      value={draft ?? String(value)}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      onChange={(e) => {
        const raw = (e.target as HTMLInputElement).value;
        const n = parseSettingNumber(raw);
        const inRange = n !== null && clampSettingNumber(spec, n) === n;
        setDraftState({ text: raw, forValue: inRange ? n : value });
        if (inRange) onCommit(n);
      }}
      onBlur={(e) => commitClamped((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commitClamped((e.target as HTMLInputElement).value);
      }}
      className="w-24 text-right"
    />
  );
}

const EMPTY_SETTING_SELECT_OPTIONS: readonly SegmentedControlOption<string>[] = [];
const RESET_DEFAULT_ICON = (
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
);

export function settingToggleSwitchClassName(checked: boolean): string {
  return checked
    ? SETTING_TOGGLE_SWITCH_ON_CLASS_NAME
    : SETTING_TOGGLE_SWITCH_OFF_CLASS_NAME;
}

export function settingToggleKnobClassName(checked: boolean): string {
  return checked
    ? SETTING_TOGGLE_KNOB_ON_CLASS_NAME
    : SETTING_TOGGLE_KNOB_OFF_CLASS_NAME;
}

interface SettingItemRowProps {
  readonly spec: SettingItemSpec;
  /**
   * race(R58):写 settings value 前复查该 setting item 仍注册(用户操作前可能被插件 unregister)。
   * 默认恒真(单测 / 不关心场景);渲染行的父组件(CategoryTabContent / SettingsSearchResults)
   * 注入 live 检查 `(id) => coApp.settingItems.get(id) !== undefined`,使已移除 setting 的旧控件
   * 不再把 override 写到不存在的 id(localStorage 残留 + 同 id 重注册意外继承)。
   */
  readonly isStillRegistered?: (id: string) => boolean;
}

export function SettingItemRow({
  spec,
  isStillRegistered = () => true,
}: SettingItemRowProps) {
  const t = useT();
  const locale = useLocale();
  const title = spec.titleKey ? t(spec.titleKey) : spec.title;
  const description = spec.descriptionKey
    ? t(spec.descriptionKey)
    : spec.description;
  const stored = useSettingsValuesStore((s) => s.values[spec.id]);
  const setValueRaw = useSettingsValuesStore((s) => s.setValue);
  const resetRaw = useSettingsValuesStore((s) => s.reset);
  // race(R58):所有写入经此包装,写前复查 setting 仍注册;已移除则跳过(不写不报)。
  const setValue = (id: string, v: SettingItemValue): void => {
    if (isStillRegistered(id)) setValueRaw(id, v);
  };
  const reset = (id: string): void => {
    if (isStillRegistered(id)) resetRaw(id);
  };
  const value = stored ?? spec.default;
  // values 中存在 override → 显示 reset;undefined 表示走 default,无需 reset
  const isOverridden = stored !== undefined;
  // a11y(A21,A4 同族):把设置标题与控件建立可访问关联 —— 标题给稳定 id,number/text/select
  // 控件 aria-labelledby 指向它,否则 AT 聚焦只读「spinbutton/edit text/radiogroup」不知编辑哪项。
  const titleId = `setting-title-${spec.id}`;
  const selectOptions = useMemo<
    readonly SegmentedControlOption<string>[]
  >(() => {
    void locale; // deps:t 内部按当前 locale 翻译 labelKey
    if (spec.type !== 'select' || !spec.enum) {
      return EMPTY_SETTING_SELECT_OPTIONS;
    }
    const options = new Array<SegmentedControlOption<string>>(spec.enum.length);
    for (let i = 0; i < spec.enum.length; i += 1) {
      const o = spec.enum[i]!;
      options[i] = {
        id: o.value,
        label: o.labelKey ? t(o.labelKey) : o.label,
      };
    }
    return options;
  }, [locale, spec.enum, spec.type, t]);

  return (
    <div className="flex items-start justify-between gap-6 border-b border-line/50 py-5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span id={titleId} className="text-sm text-fg">
            {title}
          </span>
          {/* id chip:demo 同款浅底 uppercase 紧贴 title 显示,取代独占一行 */}
          <code className="rounded bg-panel-soft/70 px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-muted/70">
            {spec.id}
          </code>
        </div>
        {description && (
          <div className="mt-1 text-xs text-fg-muted">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {spec.type === 'boolean' && (
          <ToggleSwitch
            checked={Boolean(value)}
            onChange={(v) => setValue(spec.id, v)}
            ariaLabel={title}
          />
        )}
        {spec.type === 'select' && spec.enum && (
          <SegmentedControl
            size="sm"
            ariaLabelledby={titleId}
            options={selectOptions}
            value={String(value)}
            onChange={(id) => setValue(spec.id, id)}
          />
        )}
        {spec.type === 'number' && (
          <div className="flex items-center gap-1">
            <NumberSettingInput
              spec={spec}
              value={value}
              titleId={titleId}
              onCommit={(n) => setValue(spec.id, n)}
            />
            {spec.unit && (
              <span className="select-none rounded bg-panel-soft px-1.5 py-0.5 text-2xs uppercase tracking-wider text-fg-dim">
                {spec.unit}
              </span>
            )}
          </div>
        )}
        {spec.type === 'text' && (
          <Input
            type="text"
            size="sm"
            aria-labelledby={titleId}
            value={String(value)}
            // 边界(E293,E290 同族 / before-store 输入截断):text 设置值 onChange 截断到 SI_TEXT_VALUE_MAX。
            // values-store.setValue 虽已截断(E142/E241,持久层安全),但 UI 此前无 maxLength/slice → 超长
            // paste 仍瞬时进 DOM 原生值 + onChange 事件 + setValue 调用链。maxLength 原生拦键入/paste,
            // onChange slice 兜底(与 CreateInput leaf 名 E290 同款 UI-transient 防御)。
            maxLength={SI_TEXT_VALUE_MAX}
            onChange={(e) =>
              setValue(
                spec.id,
                (e.target as HTMLInputElement).value.slice(0, SI_TEXT_VALUE_MAX),
              )
            }
            className="w-48"
          />
        )}
        {/* 常驻占位避免 reset 时 Input 等控件位置跳动;非 override 状态下
         *  invisible + pointer-events-none 保留布局但不响应 */}
        <IconButton
          size="xs"
          onClick={() => isOverridden && reset(spec.id)}
          // a11y(A12):未覆盖时仅 invisible 仍可 Tab 聚焦到不可见无效按钮 → disabled 从 tab
          // 顺序移除 + 不可点(常驻占位保留布局不跳动,但键盘/AT 不再触达)。
          disabled={!isOverridden}
          title={t('settings.item.reset_default', { default: String(spec.default) })}
          aria-label={t('settings.item.reset_default_aria')}
          className={isOverridden ? '' : 'pointer-events-none invisible'}
        >
          {RESET_DEFAULT_ICON}
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
  /** a11y(A4):role=switch 须有可访问名,否则 AT 只读「switch checked」不知切换哪个设置。 */
  readonly ariaLabel: string;
}

function ToggleSwitch({ checked, onChange, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={settingToggleSwitchClassName(checked)}
    >
      <span className={settingToggleKnobClassName(checked)} />
    </button>
  );
}
