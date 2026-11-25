# command-palette(⌘P 浮层 / 模糊搜索 / 键盘导航)

行为契约:**全局 ⌘P 打开 design Modal,Input 输入模糊搜索 CommandRegistry 中的所有命令,
↑↓ 切换选中,Enter 执行,Esc 关闭。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/fuzzy.ts` | 纯函数:`fuzzyScore` / `fuzzyFilter` |
| `src/plugins/command-palette/store.ts` | Zustand store:isOpen / query / selectedIndex |
| `src/plugins/command-palette/CommandPalette.tsx` | UI 组件,挂在 App 顶层 |
| `src/plugins/command-palette/useCommandPaletteHotkey.ts` | ⌘P 全局 hook |

## 关键行为

### fuzzy 搜索

- `fuzzyScore(query, target)`:子序列匹配,返回 number|null
  - null = 不匹配(query 字符在 target 中没按序出现)
  - 0 = query 为空(全匹配)
  - 越高越优:首字母 / 词边界(. _ - space 后)+10,普通匹配 +1,连续匹配 +5
  - 大小写不敏感
- `fuzzyFilter(items, query, getStrLower)`:按 score 降序返候选(getStrLower 返回预小写的 target)
- `fuzzyMatchIndices(query, target)`:命中字符下标(与打分同一贪心子序列,有分 ⇔ 有下标),只供行内高亮,
  不参与过滤排序;不命中 null,空 query `[]`

### store

- `isOpen` / `query` / `selectedIndex` 字段
- `open()` 重置 query='' selectedIndex=0
- `close()` 清空
- `setQuery(q)` 同时把 selectedIndex 复位 0
- `moveSelection(delta, max)` 循环移动(下到底跳头,上到头跳尾)

### CommandPalette UI

- 用 design `Modal` + `Input size='sm'`
- `commands` prop 来自 `app.commands.getAll()`(组件外订阅)
- 按 fuzzy 排序后渲染列表
- 当前选中行 `bg-hover text-fg`,其它 `text-fg-muted`
- 点击 / Enter 执行当前命令 + close
- 命中字符高亮(VSCode Quick Input highlights):有 query 时按匹配源「分类 标题」的命中下标,分类前缀与标题里的命中
  字符各包 `<mark>`(`PICKER_MATCH_CLASS_NAME`:`text-list-highlight` 加粗、背景透明,对比度见 picker-shared,
  强制颜色下划线见 forced-colors-states);只为可见行计算;行文本不变(读屏名称连贯)。只靠英文原名命中的行
  不高亮(显示的本地化标题里没有命中字符;行尾英文名只说明为何命中)
- Esc 由 Modal 内置 close 处理

### 本地化界面可搜英文命令名(VSCode commandAlias)

- 界面语言非 en 时,每条命令另算英文原名(en catalog 里 titleKey / categoryKey 的值;无 key 或 en 无此 key 用
  CommandSpec 的 title / category —— 约定它们是英文 fallback),与本地化文本不同才作别名
- 搜索先按本地化「分类 标题」fuzzy,再对其余命令按英文「Category Title」fuzzy;英文命中排在本地化命中之后
- 只靠英文命中的行,行尾以 picker 次要色(`pickerRowSecondaryClassName`:常态 text-fg-dim,选中 / 悬停 text-fg-muted,
  对比度见 picker-shared)显示 `Category: Title`;命中本地化文本或 en 界面不显示
- 快捷键设置页搜索同理(`keybindings-tab-content`)

### ⌘P hotkey

- `useCommandPaletteHotkey()` 在 document 上监听 `keydown`
- 平台主修饰键 + Shift + P 时 open + preventDefault:mac 只认 Cmd(Ctrl 留给终端 / 编辑器的
  Control 序列),其它平台只认 Ctrl
- 已 open 时再按 ⌘P → close
- 卸载组件 → 清监听
