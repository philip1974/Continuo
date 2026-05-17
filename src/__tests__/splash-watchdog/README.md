# SplashWatchdog(启动卡屏看门狗)

行为契约:**App 渲染后 splash 必须在 3000ms 内退出(由 layoutReady 翻 true 触发);
若到时仍卡在 splash,看门狗弹出 design Modal 显示当前 store 状态 + 3 个操作按钮
(强制进入应用 / 打开日志目录 / 重新启动),并向 breadcrumb 写一条 `splash_timeout` 事件。
看门狗触发后用户即使不点也不能再被无声黑屏遮挡 — 必有可见出口。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/decor/SplashWatchdog.tsx` | UI:Modal + 3 个 Button + 状态摘要 |
| `src/shell/App.tsx` | 挂载 watchdog;监听 layoutReady 翻 true 时停表 |
| `src/lib/diagnostics/breadcrumb.ts` | renderer 端 breadcrumb 入口(写 splash_timeout 事件) |

## 关键行为

### 计时与触发

- App mount 起表,3000ms 内 `layoutReady === true` → 计时器清掉,Watchdog 永远不显示
- 3000ms 时仍 `layoutReady === false` → Watchdog Modal 渲染
- Watchdog 渲染时往 breadcrumb 写一条 `{ event: 'splash_timeout', layoutReady, workspaceRoot, sidebarOpen, hasCoApi, cssLoaded }`

### 显示态

- Modal 顶部标题:「启动卡屏诊断」
- 中部正文:列出 layoutReady / workspaceRoot / sidebarOpen / hasCoApi / cssLoaded 各项当前值
- 底部 3 个按钮:
  - **强制进入应用**(primary)→ 手动把 layoutReady 翻 true(通过外部传入的 forceEnter 回调)+ onClose
  - **打开日志目录**(secondary)→ 调 coApi.shell.openLogsDir() — 失败也不 crash
  - **重新启动**(danger)→ 调 coApi.app.relaunch()

### 防御性

- 看门狗 Modal 自身**不依赖** Tailwind 类(防 CSS 没加载场景):wrapper 用 inline style 强制可见;
  内部按钮文字必须**不**依赖 bg-clip-text / gradient(确保 CSS 缺失时仍可读)
- Watchdog visible 后,用户即使关掉(Esc / 点遮罩)也不再弹回 — 关 = 等价"强制进入"

### 测试焦点(spec)

1. `layoutReady=false` 时 mount,500ms 内不渲染 Modal
2. `layoutReady=false` 时 mount,3100ms 后渲染 Modal
3. `layoutReady=true` 时 mount,从未渲染 Modal
4. mount 时 false,2000ms 时翻 true → Modal 不渲染
5. Modal 渲染时写 breadcrumb(mock)一次
6. 点"强制进入"按钮 → 调 forceEnter 回调
7. 点"打开日志目录" → 调 coApi.shell.openLogsDir
8. 点"重新启动" → 调 coApi.app.relaunch
