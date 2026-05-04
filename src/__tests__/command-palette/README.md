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
- `fuzzyFilter(items, query, getStr)`:按 score 降序返候选

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
- Esc 由 Modal 内置 close 处理

### ⌘P hotkey

- `useCommandPaletteHotkey()` 在 document 上监听 `keydown`
- `(e.metaKey || e.ctrlKey) && e.key === 'p'` 时 open + preventDefault
- 已 open 时再按 ⌘P → close
- 卸载组件 → 清监听
