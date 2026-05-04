# command-hotkeys(全局快捷键派发)

行为契约:**listen document keydown,匹配 commands 注册的 hotkey 即执行 cmd.fn()**。
'mod' 跨平台:metaKey(mac)或 ctrlKey(其它)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/useCommandHotkeys.ts` | matchesHotkey + useCommandHotkeys |

## 关键行为

### matchesHotkey(combo, event)

- `'mod+shift+h'` ↔ `{ metaKey/ctrlKey, shiftKey, key='h' }`
- mod 同时接 cmd / ctrl 别名
- 多余修饰键(如 alt)按下时不匹配
- key 大小写不敏感

### useCommandHotkeys(commands)

- subscribe commands registry,变化即重新订阅 keydown
- 命令 fn 抛错不传染(由 cmd 自身处理,本 hook 不 wrap)
- 单事件只触发首个匹配,preventDefault + stopPropagation
