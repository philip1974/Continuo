# 多窗口启动恢复(`pickWindowsToRestore`)

行为契约:**Continuo 启动时,主窗口固定先开 windowSeq=0;之后从
`explorer.json` 的 `windows[]` 段挑出需要恢复的其它窗口段,逐个
`createMainWindow({ windowSeq, workspace })`**。issue #23 Phase 2C。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/window-restore.service.ts` | 纯函数 `pickWindowsToRestore(data, isExistingDir)` |
| `electron/main/index.ts` | `whenReady` 后调用,逐段 `createMainWindow` |

## 关键行为

### 跳过 `windowSeq === 0`(主窗已开)

主窗永远在 `pickWindowsToRestore` 之前由 main 单独 create。

### 跳过 `workspace.root === null`(空段)

无 workspace 的段没有恢复语义 — 重启时不开"空白"新窗(无意义)。

### 跳过 workspace 路径不存在 / 不是目录

用户可能删掉了项目目录。**段在磁盘保留**(以防用户改 mount 后还想要),
但启动时不开窗。

### 多个有效段 → 各自一个窗口

返回数组顺序为 `windows[]` 的物理顺序(便于稳定测试)。
