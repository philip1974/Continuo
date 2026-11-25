# 快捷键主键:⌥ / ⇧ 组合按物理键取主键(录制与匹配同源)

行为契约:**mac 上按 ⌥K、⌥E、⇧1 等组合,录到的是「alt+k」「alt+e」「shift+1」,而不是键盘布局变形后的字符
(˚ / Dead / !);录制与命令触发用同一个「事件 → 主键」函数,录到什么就按什么触发。**

## 背景

此前录制(`KeybindingCaptureModal.eventToCombo`)与匹配(`useCommandHotkeys`)都直接取 `e.key`:

- mac ⌥K 的 `e.key` 是 `˚` → 录成「⌥˚」;⌥E / ⌥U / ⌥N 是死键,`e.key` 都是 `Dead` → 全部录成 `alt+dead` 互相冲突。
- ⇧1 的 `e.key` 是 `!` → 显示「⇧!」;⇧⌘= 的 `e.key` 是 `+` → 主键是分隔符,根本录不了。
- 插件 / 手写的 `mod+alt+l` 在 mac 上永远不触发(⌥⌘L 的 `e.key` 是 `¬`)。

## 行为(对齐 VSCode:keybinding 记基础键 + 修饰键,`shift+/` 而非 `?`)

共享函数 `eventHotkeyKey(e)`(`src/plugins/command-palette/event-hotkey-key.ts`):

| 情形 | 主键来源 |
|---|---|
| 命名键(Enter / ArrowUp / F6 …) | `e.key` 小写 |
| `e.key` 为 ASCII 字母 | `e.key` 小写(非 US 布局下字母键按布局字符,不回归) |
| `e.key` 为 `Dead` / `Unidentified` | `e.code` 推出(US 布局:KeyK→k、Digit1→1、Minus→-、BracketLeft→[ …) |
| 按着 ⌥(Alt)且 `e.key` 不是 ASCII 字母 | `e.code` 推出 |
| 按着 ⇧ 且 `e.key` 是 ASCII 数字 / 符号 | `e.code` 推出 |
| 其余(无 ⌥ 的非 ASCII 字符,如德语 ü、法语 é) | `e.key` 小写(保留布局字符) |

`e.code` 不在 US 映射表(Numpad、IntlBackslash、Space …)时退回 `e.key` 小写。

### 兼容:已存的旧写法照常生效

- 修饰键含 `shift` 时,US 上档符号主键归一到基础键:`mod+shift+?` ≡ `mod+shift+/`、`shift+!` ≡ `shift+1`、
  `mod+shift+=` 由 ⇧⌘= 触发(运行时匹配、冲突检测、保留键判定同一归一)。
- 旧版录下的布局变形字符(`alt+˚`、`alt+dead`)仍按 `e.key` 兜底匹配;同一按键先按新主键找命令,找不到才兜底,
  新录的 `alt+u` 不会被旧 `alt+dead` 抢走。

### 不受影响

- 终端 / 编辑器内部按键:只改「命令热键」的主键判定,终端与编辑器本身的键处理不变。

## 取舍

- 物理键映射只内置 US 布局(与 VSCode 回退表一致);非 US 布局下 ⌥ + 字母键取物理键(VSCode 用系统布局表给出布局字符,
  本实现不读系统布局)。无 ⌥ 的字母 / 非 ASCII 字符仍用 `e.key`,故非 US 布局的普通组合不回归。
