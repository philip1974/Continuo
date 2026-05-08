# SettingItemRow(单个设置项的通用渲染器)

行为契约:**根据 spec.type 渲染对应控件:**
- **boolean → 内嵌 ToggleSwitch(role=switch,aria-checked)**
- **select → SegmentedControl,options 来自 spec.enum**
- **number → Input type=number + 可选 unit chip**
- **text → Input type=text**

**改动写入 useSettingsValuesStore;`stored !== undefined` 时显示 reset 按钮(↺ icon),
点 reset → store.reset(spec.id) 删 override 回到 default。**

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

### boolean

- 切换 → setValue(id, !value)
- ToggleSwitch role=switch,aria-checked 反映当前 value

### select

- 当前 value === 选项 id → 该选项 active
- 点选项 → setValue(id, optionId)

### number

- Input value = String(value)
- onChange → 解析,Number.isFinite false 跳过(非法输入不写)
- finite → setValue(id, n)
- spec.unit 存在 → 右侧 chip

### text

- Input value = String(value)
- onChange → setValue(id, raw 字符串)

### reset

- store.values 没该 id → reset 按钮 invisible(布局占位但不响应)
- 有 → 可见,点击 store.reset(id),删 override
