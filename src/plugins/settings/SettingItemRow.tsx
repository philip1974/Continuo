// 单个设置项的通用渲染器(M-Settings v6 / UI polish)。
// 视觉对齐 demo(Industrial IDE Dark):
//   - title 后 inline id chip(浅底 + 等宽,保留原大小写:id 区分大小写,大写化会误导照抄),取代独占一行
//   - boolean → design Switch(滑块,占空间小)
//   - select  → SegmentedControl(spec.enum)
//   - number  → Input + 单位 chip(右侧)
//   - text    → Input
//   - reset   → 始终占位的 ↺,override 时可见
//   - 右键 / Shift+F10 / 行上的「更多操作」齿轮(悬停 / 聚焦时显示)→ 菜单:重置设置 ─ 复制设置 ID / 将设置复制为 JSON
//     (VSCode settingsTree settingActions;外壳同 tab 右键菜单)。BDD: src/__tests__/list-context-menus/

import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  Badge,
  IconButton,
  Input,
  SegmentedControl,
  Switch,
  type SegmentedControlOption,
} from '@/design';
import { useLocale, useT } from '@/i18n';
import { dispatchContextMenuAt, isContextMenuKey, isEditableTarget } from '@/lib/context-menu-key';
import { TabContextMenu, type TabMenuEntry } from '@/lib/TabContextMenu';
import { ResetIcon } from '@/lib/ui-icons';
import { copyToClipboardOrNotify } from '@/panels/Explorer/copy-to-clipboard';
import { GeneralIcon } from './tab-icons';
import { WORKBENCH_TRUSTED_DOMAINS } from './core-setting-specs';
import { TrustedDomainsSettingRow } from './TrustedDomainsSettingRow';
import {
  clampSettingNumber,
  coerceSettingValue,
  SI_TEXT_VALUE_MAX,
  type SettingItemSpec,
  type SettingItemValue,
} from '../registries/SettingItemRegistry';
import { useSettingsValuesStore } from './values-store';
import { ownValue } from '@shared/own-value';

/** 把输入框文本解析成可提交的数字;空串 / 非有限数 → null。 */
function parseSettingNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 允许范围提示(对齐 VSCode 设置的校验文案);合法值返回 null。 */
function numberRangeError(
  spec: SettingItemSpec,
  n: number | null,
  t: ReturnType<typeof useT>,
): string | null {
  if (n !== null && clampSettingNumber(spec, n) === n) return null;
  const { min, max } = spec;
  if (typeof min === 'number' && typeof max === 'number') return t('settings.item.number_range', { min, max });
  if (typeof min === 'number') return t('settings.item.number_min', { min });
  if (typeof max === 'number') return t('settings.item.number_max', { max });
  return t('settings.item.number_nan');
}

/**
 * number 设置项输入框的草稿状态(对齐 VSCode 设置编辑器):键入中的文本放本地草稿,范围内的值即时生效;
 * 越界 / 非数字的草稿不保存、也不静默钳制改值(此前失焦时把 99 改成 24、把空改回原值,用户不知道输入被改了),
 * 而是保留草稿并返回允许范围提示,由调用方在行内显示;改成合法值后提示消失。
 */
function useNumberSettingDraft(
  spec: SettingItemSpec,
  value: SettingItemValue,
  onCommit: (n: number) => void,
) {
  const t = useT();
  // 草稿记下它对应的「已知值」:键入范围内的值会立即提交(已知值 = 提交的数),越界的中间值不提交(已知值 =
  // 当时的值)。之后 value 若不再等于已知值,说明被别处改了(点了重置、别的窗口改了设置)→ 草稿作废,显示
  // 新值;否则键入的旧文本会一直遮住它。
  const [draftState, setDraftState] = useState<{ text: string; forValue: SettingItemValue } | null>(
    null,
  );
  // 已作废的草稿在渲染期就清掉(React 允许对本组件的 state 这样做):只把它当「派生为 null」的话,值之后
  // 若又变回 forValue,旧文本会复活。
  if (draftState !== null && !Object.is(draftState.forValue, value)) setDraftState(null);
  const draft = draftState !== null && Object.is(draftState.forValue, value) ? draftState.text : null;
  const error = draft === null ? null : numberRangeError(spec, parseSettingNumber(draft), t);
  // 失焦 / Enter:合法草稿已在键入时提交,丢弃草稿回显规整后的值(「016」→「16」);非法草稿保留(连同提示)。
  const settle = (): void => {
    if (draft !== null && error === null) setDraftState(null);
  };
  return {
    error,
    inputProps: {
      value: draft ?? String(value),
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        const n = parseSettingNumber(raw);
        const inRange = n !== null && clampSettingNumber(spec, n) === n;
        setDraftState({ text: raw, forValue: inRange ? n : value });
        if (inRange) onCommit(n);
      },
      onBlur: settle,
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') settle();
      },
    },
  };
}

const EMPTY_SETTING_SELECT_OPTIONS: readonly SegmentedControlOption<string>[] = [];
/** 行内编辑控件(开关 / 输入框 / 分段控件里当前可 Tab 的那一项);重置后焦点移到这里。 */
const ROW_CONTROL_SELECTOR = 'input, [role="switch"], [role="radio"][tabindex="0"]';
const RESET_DEFAULT_ICON = <ResetIcon size={12} />;
const MORE_ACTIONS_ICON = <GeneralIcon />;
/** 设置项主体布局:窄于 32rem(行自身宽度)上下排列,否则左右并排(控件靠右)。导出供规范断言。 */
export const SETTING_ROW_LAYOUT_CLASS_NAME =
  'flex flex-col items-start gap-3 @lg:flex-row @lg:justify-between @lg:gap-6';

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

export function SettingItemRow(props: SettingItemRowProps) {
  // 外链受信域名的值在 main(不进设置值 store),用专门的行(见 WORKBENCH_TRUSTED_DOMAINS)
  if (props.spec.id === WORKBENCH_TRUSTED_DOMAINS.id) return <TrustedDomainsSettingRow spec={props.spec} />;
  return <ValueSettingItemRow {...props} />;
}

function ValueSettingItemRow({
  spec,
  isStillRegistered = () => true,
}: SettingItemRowProps) {
  const t = useT();
  const locale = useLocale();
  const title = spec.titleKey ? t(spec.titleKey) : spec.title;
  const description = spec.descriptionKey
    ? t(spec.descriptionKey)
    : spec.description;
  const stored = useSettingsValuesStore((s) => ownValue(s.values, spec.id));
  const setValueRaw = useSettingsValuesStore((s) => s.setValue);
  const resetRaw = useSettingsValuesStore((s) => s.reset);
  // race(R58):所有写入经此包装,写前复查 setting 仍注册;已移除则跳过(不写不报)。
  // 改回默认值 = 重置(VSCode settingsEditor2.updateChangedSetting:新值 === 默认值时写 undefined):不留「等于默认值的
  // override」,否则竖条 / 读屏「已修改」/ 重置按钮 / `@modified` 都还在。只在设置页这条写入路径做(同 VSCode 在设置编辑器层
  // 而非 configurationService 做),store.setValue 供插件 / 其它调用方的语义不变。经 resetRaw 走:删 localStorage 键(跨窗同步
  // 同重置)+ 本窗重置通知(语言项据此把默认语言推给 main —— 删键后 LanguageFromSettings 不再从存储值推送)。
  // 按写端同一 coerceSettingValue 规整后比较(number clamp 后 === 默认 number,不拿字符串比)。
  const setValue = (id: string, v: SettingItemValue): void => {
    if (!isStillRegistered(id)) return;
    if (coerceSettingValue(spec, v) === spec.default) resetRaw(id);
    else setValueRaw(id, v);
  };
  // 重置后按钮立刻 disabled + invisible,焦点会掉到 body → 提交后把焦点移到同行编辑控件(select 须等重渲后
  // 新选中项才是 tabindex=0,故在 layout effect 里聚焦)。
  const controlsRef = useRef<HTMLDivElement>(null);
  const focusControlAfterResetRef = useRef(false);
  useLayoutEffect(() => {
    if (!focusControlAfterResetRef.current) return;
    focusControlAfterResetRef.current = false;
    controlsRef.current?.querySelector<HTMLElement>(ROW_CONTROL_SELECTOR)?.focus();
  });
  const reset = (id: string): void => {
    if (!isStillRegistered(id)) return;
    focusControlAfterResetRef.current = true;
    resetRaw(id);
  };
  // 与消费者(useSettingValue)同一 coerceSettingValue 规整:越界 number clamp、非法
  // select 回退 default —— 否则设置页显示篡改/旧版 localStorage 原始脏值,与实际生效值不一致。
  const value = coerceSettingValue(spec, stored ?? spec.default);
  // values 中存在 override → 显示 reset;undefined 表示走 default,无需 reset
  const isOverridden = stored !== undefined;
  // 重置提示里的默认值:select 显示选项文案(如语言「中文」),其余显示原始值。
  const defaultOption =
    spec.type === 'select' ? spec.enum?.find((o) => o.value === spec.default) : undefined;
  const defaultLabel = defaultOption
    ? defaultOption.labelKey
      ? t(defaultOption.labelKey)
      : defaultOption.label
    : String(spec.default);
  // a11y(A21,A4 同族):把设置标题与控件建立可访问关联 —— 标题给稳定 id,number/text/select
  // 控件 aria-labelledby 指向它,否则 AT 聚焦只读「spinbutton/edit text/radiogroup」不知编辑哪项。
  const titleId = `setting-title-${spec.id}`;
  const numberErrorId = `setting-error-${spec.id}`;
  const modifiedId = `setting-modified-${spec.id}`;
  const modifiedDescribedBy = isOverridden ? modifiedId : undefined;
  // number 草稿 / 越界提示(其它类型不用,hook 须无条件调用)
  const numberDraft = useNumberSettingDraft(spec, value, (n) => setValue(spec.id, n));
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

  // 右键菜单(VSCode settingsTree settingActions 同序):重置设置(未覆盖时置灰)─ 复制设置 ID / 将设置复制为 JSON
  //(`"id": 值`,值为当前生效值)。跳过:复制为 URL(无 URL 协议入口)、应用到所有配置文件 / 同步(无配置文件 / 同步)。
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuEntries = (): TabMenuEntry[] => {
    const copyFailed = t('panels.terminal.ctx.copy_failed');
    return [
      { label: t('settings.item.ctx.reset'), onSelect: () => reset(spec.id), disabled: !isOverridden },
      'separator',
      { label: t('settings.item.ctx.copy_id'), onSelect: () => void copyToClipboardOrNotify(spec.id, copyFailed) },
      {
        label: t('settings.item.ctx.copy_json'),
        onSelect: () => void copyToClipboardOrNotify(`"${spec.id}": ${JSON.stringify(value, undefined, '  ')}`, copyFailed),
      },
    ];
  };

  // 窄宽(设置面板被挤到几百像素)时按行自身宽度(容器查询 @container)改为上下排列:标题 / 描述在上、控件
  // 在下(VSCode 设置项本就是上下排列);宽于 32rem 才左右并排。左右并排时控件区 shrink-0,若不换行,
  // 左侧只剩几十像素 → 描述一行一个词、标题被截断。标题行可换行;id 徽标过长时省略号截断而不撑破行。
  // 行可聚焦(tabIndex=-1,不进 Tab 序):右键按下即聚焦本行,菜单 Esc 关闭后焦点回到本行。
  // 键盘回焦(Esc)时 focus-visible 画内嵌 focus-ring 轮廓(同搜索结果树 / 资源管理器行);鼠标点击不画。
  return (
    <TabContextMenu entries={menuEntries} keyboardAnchor={() => moreRef.current}>
      <div
        tabIndex={-1}
        data-setting-row={spec.id}
        data-modified={isOverridden ? 'true' : undefined}
        className="group/setting @container relative border-b border-line/50 py-5 outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring last:border-b-0"
      >
        {/* 已修改指示条(VSCode .setting-item-modified-indicator:有 override 的行左侧一道主色竖线,悬停提示「已修改」),
            画在内容区左内边距里;读屏用标题后的 sr-only「已修改」。 */}
        {isOverridden && (
          <span
            aria-hidden="true"
            data-testid="setting-modified-indicator"
            title={t('settings.item.modified_hint')}
            className="absolute inset-y-5 -left-3 w-1.5 border-l-2 border-accent"
          />
        )}
        <div className={SETTING_ROW_LAYOUT_CLASS_NAME}>
          <div className="min-w-0 max-w-full flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span id={titleId} className="min-w-0 break-words text-sm text-fg">
                {title}
              </span>
              {/* VSCode 设置行 aria-label 的「Modified.」:控件经 aria-describedby 指向它,读屏聚焦即读到「已修改」;
                  不放进标题(可访问名),否则改值后控件的名字跟着变。 */}
              {isOverridden && (
                <span id={modifiedId} className="sr-only">
                  {t('settings.item.modified')}
                </span>
              )}
              {/* id chip:design Badge xs(浅底)+ <code> 等宽紧贴 title 显示,取代独占一行;不 uppercase —— id 区分大小写 */}
              <Badge size="xs" className="min-w-0 max-w-full">
                <code className="min-w-0 truncate" title={spec.id}>
                  {spec.id}
                </code>
              </Badge>
              {/* 「更多操作」(VSCode 设置项左侧齿轮):悬停 / 行内有焦点 / 菜单打开时显示,点击在按钮处打开同一菜单 */}
              <IconButton
                ref={moreRef}
                size="xs"
                title={t('settings.item.more_actions')}
                aria-label={t('settings.item.more_actions_aria', { setting: title })}
                aria-haspopup="menu"
                onClick={(e) => dispatchContextMenuAt(e.currentTarget)}
                className="self-center opacity-0 focus-visible:opacity-100 group-hover/setting:opacity-100 group-focus-within/setting:opacity-100 group-data-[state=open]/setting:opacity-100"
              >
                {MORE_ACTIONS_ICON}
              </IconButton>
            </div>
            {description && (
              <div className="mt-1 text-xs text-fg-muted">{description}</div>
            )}
            {spec.type === 'number' && numberDraft.error !== null && (
              <div id={numberErrorId} className="mt-1 text-xs text-error">
                {numberDraft.error}
              </div>
            )}
          </div>
          {/* 输入框里右键 / Shift+F10 留给原生编辑菜单(剪切 / 复制 / 粘贴),不打开设置项菜单 */}
          <div
            ref={controlsRef}
            className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2"
            onContextMenu={(e) => {
              if (isEditableTarget(e.target)) e.stopPropagation();
            }}
            onKeyDown={(e) => {
              if (isEditableTarget(e.target) && isContextMenuKey(e.nativeEvent)) e.stopPropagation();
            }}
          >
          {spec.type === 'boolean' && (
            // a11y(A4):role=switch 须有可访问名(= 设置标题),否则 AT 只读「switch checked」不知切换哪个设置。
            <Switch
              checked={Boolean(value)}
              onCheckedChange={(v) => setValue(spec.id, v)}
              aria-label={title}
              aria-describedby={modifiedDescribedBy}
            />
          )}
          {spec.type === 'select' && spec.enum && (
            <SegmentedControl
              size="sm"
              ariaLabelledby={titleId}
              ariaDescribedby={modifiedDescribedBy}
              options={selectOptions}
              value={String(value)}
              onChange={(id) => setValue(spec.id, id)}
            />
          )}
          {spec.type === 'number' && (
            <div className="flex min-w-0 max-w-full items-center gap-1">
              <Input
                type="number"
                size="sm"
                aria-labelledby={titleId}
                aria-invalid={numberDraft.error !== null ? true : undefined}
                aria-describedby={
                  [numberDraft.error !== null ? numberErrorId : '', modifiedDescribedBy ?? ''].join(' ').trim() ||
                  undefined
                }
                min={spec.min}
                max={spec.max}
                // 未给 step → "any"(VSCode settingsTree:非整数设置 inputBox.step='any'):↑ / ↓ 一次 ±1、任意小数合法。
                step={spec.step ?? 'any'}
                {...numberDraft.inputProps}
                className="w-24 min-w-0 max-w-full text-right"
              />
              {spec.unit && (
                <Badge size="xs" className="select-none uppercase tracking-wider">
                  {spec.unit}
                </Badge>
              )}
            </div>
          )}
          {spec.type === 'text' && (
            <Input
              type="text"
              size="sm"
              aria-labelledby={titleId}
              aria-describedby={modifiedDescribedBy}
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
              className="w-48 max-w-full"
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
            title={t('settings.item.reset_default', { default: defaultLabel })}
            aria-label={t('settings.item.reset_default_aria')}
            className={isOverridden ? '' : 'pointer-events-none invisible'}
          >
            {RESET_DEFAULT_ICON}
          </IconButton>
          </div>
        </div>
      </div>
    </TabContextMenu>
  );
}
