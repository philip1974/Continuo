# 快捷键键名词汇:捕获 / 匹配 / 显示 一致

行为契约:**同一个快捷键字符串,在「录制」「触发匹配」「界面显示」三处用同一套键名理解。**

## 背景

三处此前各认一套词汇:

- 录制(`KeybindingCaptureModal.eventToCombo`)产出真实 `e.key` 小写名:`arrowup`、`escape`、
  `enter`,非 mac 上的 Meta 键记为 `cmd`。
- 匹配(`useCommandHotkeys`)把主键与 `e.key` 小写直接比较,不认别名。
- 显示(`format-hotkey`)的特殊键表只有别名 `up/down/left/right/esc/return/space/del`,
  修饰键表没有 `cmd`。

后果:插件注册 `mod+up` / `mod+esc` 时界面显示正常但永远不触发;用户录制方向键后显示成 `ARROWUP`;
`cmd+…` 显示成 `CMD`。

## 行为

### 匹配:主键别名归一到 `e.key` 名

| 写法 | 等价于 |
|---|---|
| `up` / `down` / `left` / `right` | `arrowup` / `arrowdown` / `arrowleft` / `arrowright` |
| `esc` | `escape` |
| `return` | `enter` |
| `del` | `delete` |

真实 `e.key` 名本身照常匹配。

### 冲突检测:同一套归一

- 录制出的 `mod+arrowup` 与已注册的 `mod+up` 判为冲突(别名现在真的会触发,不归一就会两条命令抢同一个键而不提示)。

### 显示:认真实 `e.key` 名与 `cmd`

- `arrowup` 等与 `up` 等显示相同(↑ ↓ ← →)。
- `cmd`:mac 显示 `⌘`,其它平台显示 `Win`。

## 不在本主题验证

- 平台感知的 `mod`(R15)、录制侧的组合合法性(E145)→ 既有规范。
