# format-hotkey(命令 hotkey 显示格式化)

行为契约:**把 raw hotkey 字面(`mod+,` / `mod+shift+h`)格式化为
platform-aware 的展示串**。

- mac:Unicode 符号紧凑形式 `⌘,` / `⌘⇧H` / `⌘⌥⇧K`
- others:文字 `+` 分隔 `Ctrl+,` / `Ctrl+Shift+H` / `Ctrl+Alt+Shift+K`

> 注意:本 topic 只管**显示**;命令的 hotkey 注册值仍是 `mod+x` 形态由
> useCommandHotkeys 内 matchesHotkey 解析(那一层不动,跨平台同 raw)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/format-hotkey.ts` | formatHotkey(raw, platform) + detectPlatform() |

需 export 的形态:

```ts
export type Platform = 'mac' | 'other';

export function formatHotkey(raw: string, platform: Platform): string;
export function detectPlatform(): Platform;
```

## 关键行为

### 修饰键映射

| raw | mac | other |
|---|---|---|
| `mod` | `⌘` | `Ctrl` |
| `shift` | `⇧` | `Shift` |
| `alt` / `option` | `⌥` | `Alt` |
| `ctrl` | `⌃` | `Ctrl` |

### 特殊键名

| raw | mac | other |
|---|---|---|
| `enter` / `return` | `↵` | `Enter` |
| `escape` / `esc` | `⎋` | `Esc` |
| `space` | `␣` | `Space` |
| `tab` | `⇥` | `Tab` |
| `backspace` | `⌫` | `Backspace` |
| `delete` / `del` | `⌦` | `Del` |
| `up` | `↑` | `↑` |
| `down` | `↓` | `↓` |
| `left` | `←` | `←` |
| `right` | `→` | `→` |

### 一般字面

字母 → 大写(`a` → `A`,`h` → `H`)。
数字 / 符号(`,` `.` `/` 等)原样保留。

### 拼接规则

- mac:无分隔符紧贴 `⌘⇧H`
- other:`+` 分隔 `Ctrl+Shift+H`
- 单键(无修饰)两平台都直接 `Esc` / `↵` / `K`

### 大小写不敏感

- 输入 `Mod+Shift+H` / `MOD+SHIFT+H` / `mod+shift+h` 等价

### 空 / 异常

- 空字符串 → `''`
- 全是分隔符 `+` → `''`
- 未知键名 → uppercase(`F1` → `F1`)

### detectPlatform()

- `navigator.platform` 含 `Mac` → `'mac'`
- 其它(Win / Linux / Unknown) → `'other'`
- jsdom 测试环境(`navigator.platform` 通常空) → `'other'`(不抛)
- 无 `navigator`(SSR) → `'other'`

## 不在本主题验证

- hotkey 真实派发(由 command-hotkeys topic 持有 matchesHotkey)
- CommandPalette UI 渲染(由 command-palette topic 持有,本 topic 只
  保证 formatHotkey 字符串形态)
