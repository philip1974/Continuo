# 多窗口启动恢复(`pickWindowsToRestore`)

行为契约:**Continuo 启动时,主窗口固定先开 windowSeq=0;之后从
`explorer.json` 的 `windows[]` 段挑出需要恢复的其它窗口段,逐个
`createMainWindow({ windowSeq, workspace })`**。issue #23 Phase 2C。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/window-restore.service.ts` | async 纯函数 `pickWindowsToRestore(data, isExistingDir)`(判定可返回 Promise) |
| `electron/main/index.ts` | `whenReady` 后以 `fs.promises.stat` 判定调用,按返回顺序逐段 `createMainWindow` |

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

### 目录判定 async + 有界并发(性能审计 #7)

目录判定不再在 main 进程串行 `statSync`(慢挂载 / 断开网络盘会阻塞 main)。按 `windows[]`
顺序每批取至多 `RESTORE_CHECK_CONCURRENCY`(8)个候选并发判定,再按原顺序回放串行规则:

- 返回集合、`MAX_RESTORE_WINDOWS` 上限与顺序与串行逐一一致(结果按原索引收集,不按完成顺序)
- 判定次数与串行相同:批大小不超过剩余检查预算(`MAX_RESTORE_CHECKS`)与剩余开窗名额
- 重复 windowSeq:同批不放两个同 seq 段 —— 前段未命中时后段仍被检查,前段命中则后段不判定
