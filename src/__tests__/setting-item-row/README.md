# SettingItemRow(单个设置项的通用渲染器)

行为契约:**根据 spec.type 渲染对应控件:**
- **boolean → design `Switch`(role=switch,aria-checked;见 `design-system-switch`)**
- **select → SegmentedControl,options 来自 spec.enum**
- **number → Input type=number + 可选 unit chip**
- **text → Input type=text**

**改动写入 useSettingsValuesStore;`stored !== undefined` 时显示 reset 按钮(↺ icon),
点 reset → store.reset(spec.id) 删 override 回到 default。**

## 已修改指示与 number 步长(第 56 轮)

- 有 override 的行:左侧主色竖条(`border-accent`,VSCode `.setting-item-modified-indicator`;悬停提示「此设置已修改。」)+ sr-only
  「已修改」,开关 / 分段控件 / 输入框经 aria-describedby 读到(对应 VSCode 行 aria-label 的 "Modified.";不进可访问名,改值不改控件名);无 override 都不显示
- number 输入框未给 `step` → `step="any"`(VSCode settingsTree 非整数设置 `inputBox.step='any'`):↑ / ↓ 一次 ±1、小数合法。
  `editor.lineHeight` / `terminal.integrated.lineHeight` / `window.zoomLevel` 不再带 0.1 / 1 步长(此前行高 0 ↑ 得 0.1 → 8px 行高文字重叠)


## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/SettingItemRow.tsx` | UI |
| `src/plugins/settings/values-store.ts` | values + setValue/reset |

## 关键行为

### 显示

- title + id chip(<code> 元素)同行
- description 存在 → 第二行
- 类型对应控件渲染
- 显示值 = coerceSettingValue(spec, stored ?? default),与消费者同一规整:越界 number 显示 clamp 值、
  非法 select 显示 default(不显示原始脏值)

### boolean

- 切换 → setValue(id, !value)
- design `Switch`(`wm-switch`)role=switch,aria-checked / data-checked 反映当前 value,aria-label = 设置标题

### select

- 当前 value === 选项 id → 该选项 active
- 点选项 → setValue(id, optionId)

### number

- 键入中的文本放本地草稿:范围内的值即时 setValue;越界的中间值不钳制回写(否则无法键入目标值)
- 对齐 VSCode:越界 / 清空 / 非数字的草稿**不保存、不静默改值**(失焦 / Enter 也不钳制),行内(描述下方)用
  `text-error` 显示允许范围(「值须在 10–24 之间」;只有下限 / 上限时「值须不小于 / 不大于 N」;无范围「值须为数字」),
  输入框 `aria-invalid="true"` + `aria-describedby` 指向提示;改成合法值后即保存、提示与 aria 属性一并清除
- 失焦 / Enter 时合法草稿丢弃,回显规整后的值

- spec.unit 存在 → 右侧 chip

### text

- Input value = String(value)
- onChange → setValue(id, raw 字符串),超过 `SI_TEXT_VALUE_MAX` 的部分截断

### reset

- store.values 没该 id → reset 按钮 invisible(布局占位但不响应)
- 有 → 可见,点击 store.reset(id),删 override

### 改回默认值即重置

- 对齐 VSCode `settingsEditor2.updateChangedSetting`:在设置行里把值改回默认值(按写端同一 `coerceSettingValue`
  规整后 `=== spec.default`)→ 等同「恢复默认」:删除 override(localStorage 键一并删除、跨窗同步、本窗重置通知),
  已修改竖条 / 读屏「已修改」/ 重置按钮消失
- 只在设置行写入路径生效;`store.setValue` 供插件 / 其它调用方,写默认值仍保存 override(语义不变)
