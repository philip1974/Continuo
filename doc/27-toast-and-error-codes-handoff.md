# doc/27 Toast + Error-Codes 推回 Nous & Producer 接入

## Topic 15 收尾

来自:`.claude/dev-loop/15-unified-toast-notification/`
完成日期:2026-05-17

## 未尽事项

### 1. Toast 通用化后推回 Nous shell-ui

**现状**:Topic-15 把 toast/notify 实现暂留在 `src/notifications/` 与 `electron/main/ipc/notify.ipc.ts`,**未进** `src/design/`(plan-v4 P1-5 修订:design 副本谨慎,等通用化后再推)。

**推回触发条件**:本 topic 之外**第 3 个**调用源出现时(目前 Continuo 内部统一调 `notify.error/warn/info/success` API,没有"Continuo-local 之外"的复用)。具体可能触发场景:
- Nous shell-ui 也想要 DOM 端 toast(目前 Nous 只有 shell-cli ink 端)
- 第三方 plugin 想用 `notify.*` 公共 API

**推回步骤**:
1. 在 Nous repo 新建 `packages/shells/shell-ui/src/design/notifications/`(对照 shell-cli pattern)
2. 复制 `src/notifications/{types,NotificationsProvider,Toast,ToastViewport,notify}.{ts,tsx,css}`
3. 评估上游 API 是否需要更通用化(如 `notify(msg, level, opts)` 而不限定 4 糖函数)
4. Continuo 改用 `@nous/shell-ui/design` 引入,删除 Continuo-local 副本

### 2. Push 通道 producer 接入

**现状**:`electron/main/ipc/notify.ipc.ts:pushNotification(payload)` helper 已建,但**本 topic 不接入任何 producer**(plan-v4 P1-1 "infra only")。

**候选 producer**:
1. **PTY exit 异常**(`electron/main/services/terminal.service.ts:180`):当 `exitCode != 0` 时调 `pushNotification({ level: 'error', message: 'terminal exited abnormally', code: ERROR_CODES.TERMINAL_NOT_FOUND, windowId: <ownerWinId> })`
2. **File watcher 失败**(`electron/main/ipc/fs/watch.ts`):watch 因权限/路径失效 → push warning
3. **Agent auth revoke**(`electron/main/services/agent-auth.service.ts`):被外部撤销时 push error
4. **Plugin install / update 失败**:`electron/main/services/plugins.service.ts` 异步失败

**接入原则**:
- 只有真正 user-actionable 的 main 端异常才推(避免吵闹)
- 推送时尽量传 `windowId`(targeted),不要无脑 broadcast
- 必须保留 helper 内部的 console 兜底(Op9 设计,见 Q6 修订)

## 数据

- 本 topic affects_files 实际改:**46 files**(plan-v4 declared 41 + execute 阶段净增 5:ToastViewport.css / INDEX.md / 3 spec rename .ts → .tsx)
- 错误码枚举 unique keys:**34**(main 27 + fs 7)
- 收编 alert:**15 处全部** → notify.error
- 保留 console 数:**15 处**(plan-v4 P1-4:0 删 console,7 处 mirror=false / 8 处 mirror=true)
- BDD spec 通过:**8/8 spec files,24/24 tests**(Op14c 后)
