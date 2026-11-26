# restore-windows-on-launch(重启恢复全部主窗口 + 开关)

行为契约(VSCode `window.restoreWindows`,默认 `all`,此处极简为一个布尔开关):

- **默认恢复上次退出时开着的全部主窗口**,各自的工作区、布局、焦点与窗口几何(段内容由各窗口 renderer 按 windowSeq 恢复,
  几何见 `window-state-restore/`);恢复完成后**焦点在上次最后活动的窗口**。
- 设置 → 通用 →「启动时恢复所有窗口」(`window.restoreWindows`,默认开,三语文案)。**关掉后只恢复一个**:上次最后活动的窗口。
- **运行期用户主动关掉的窗口不再恢复**;退出应用时开着的窗口全部恢复。关掉的是最后一个主窗口(macOS 关光窗口后再退出、
  Windows / Linux 关最后一个窗口即退出)→ 下次恢复它。
- 旧数据:`restoreAllWindowsOnLaunch` 缺省视为开;`openWindowSeqs` 缺省(升级后首次启动 / 从未正常退出过)→ 只开主窗 seq 0,
  不把历史上关掉的段一股脑弹出来(下次正常退出起即按记录恢复)。

## 持久化(explorer.json 顶层,main-owned)

| 字段 | 含义 |
|---|---|
| `restoreAllWindowsOnLaunch?: boolean` | 设置项的 main 侧权威值(启动恢复在任何 renderer 之前读);缺省 = true。`window:set-restore-windows` 写入(`setRestoreAllWindowsOnLaunch`:开且盘上未设置不写盘) |
| `openWindowSeqs?: number[]` | 上次退出时开着的主窗口 windowSeq,按最近活动排序,最后一个 = 最后活动 |

两者都由 main 写;renderer 整份写回(`mergeWritableIntoFull`)保留盘上值,renderer 带来的 `openWindowSeqs` 一律忽略。

## 流程

- **退出**(`before-quit`):脏确认 / flush 全部通过后置 `quitCommitted`,`persistWindowStates` 把开着的主窗口按最近活动排序
  (`orderByRecentFocus`;主窗 `focus` 与其 popout 子窗 `focus` 都记为该主窗活动)写进 `openWindowSeqs`;没有开着的主窗口时
  保留运行期维护的列表。
- **运行期关窗**(主窗 `closed`,非退出):`updateOpenWindowSeqsOnUserClose` —— 还有别的主窗口开着 → 移出;是最后一个 → 只留它。
  是否退出关窗与剩余窗口在关窗当刻同步取(写盘在文件锁里异步执行)。
- **启动**(restore 模式;命令行 / Dock 拖入目录的 dock 模式不变):`pickPrimaryWindowSeq` 同步建首窗(无记录 → 0;只恢复一个 →
  最后活动的;恢复全部 → 列表含 0 则 0,否则列表第一个);`pickWindowsToRestore` 只挑 `openWindowSeqs` 里、非首窗、有 root 且目录
  存在的段(上限 / 并发 / 取消规则见 `window-restore/`);全部建完、确实恢复了别的窗口且未取消 → `focusMainWindowBySeq(lastActiveWindowSeq)`
  (只开了首窗时它本就有焦点,不额外抢焦点)。
- popout 子窗:各主窗 renderer 从自己的布局恢复,以 `showInactive` 显示不抢焦点(`window-state-restore/`),与本流程不冲突。

## 规范

- `restore-windows.spec.ts`:默认值、首窗 / 恢复集 / 最后活动、只恢复一个、列表读取与维护、合并保留、设置写盘
- `restore-windows-setting.spec.tsx`:设置项定义与三语文案、桥接组件(挂载 / 切换推送,用户切换失败给反馈)、IPC 写入
- `startup-wiring.spec.ts`:index.ts 启动 / 退出 / 聚焦接线源码钉
- 关窗 / 退出行为:`dock-layout-per-window-seq/close-flush.spec.ts`(用户关一个 → 移出;关最后一个 → 只留它;退出 → 按最近活动排序)
- 真机:`tests/e2e/restore-windows-on-launch.spec.ts`
