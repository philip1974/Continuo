# dock-reconciler-api-rebuild — dock api 变化 / 布局恢复后终端 panel 全量重建

终端 panel 不从持久化布局恢复,只由 `DockReconciler` 依 live session 列表建出。

## 行为契约

- **api 重建**(`api-rebuild.spec.tsx`,R26):dock api 变更(dockview 重建 / onReady 重入 / HMR /
  StrictMode)= 全新空 dock → 现有 session 全部在新 api 重建(不沿用上个 api 的 diff 基线)。
- **异步布局恢复**(`restore-after-fromjson.spec.tsx`):`DockShell` onReady 在 `await layout.read()`
  之后才 `fromJSON`(dockview 内部先 `clear()`)。Reconciler 推迟到布局恢复(fromJSON / 默认布局)完成后
  才挂载 → 恢复完成时现有终端 session 仍各有 panel,不被 fromJSON 清掉;之后新增的 session 照常建 panel。
- **恢复后挂载不抢焦点**(`restore-after-fromjson.spec.tsx`):Reconciler 挂载后的首次 reconcile 是 hydrate
  (`hydrate: true`)—— 存量 user terminal 全量重建时不走 originHint 兜底聚焦,活动面板保持 fromJSON 恢复的那个
  (仅显式 pendingFocus 仍聚焦);之后真正新建的 user terminal 照旧聚焦。hydrate 只抑制 `createdAt` 早于本 api
  布局恢复开始时刻(`hydrateBefore`)的存量 session:恢复期间新建的 user terminal(Cmd+T,其 setPendingFocus
  晚于首次 reconcile 才执行)照常走 originHint 兜底聚焦。
- **恢复后 editor 自动激活不抢活动面板**(`restore-after-fromjson.spec.tsx`):恢复完成后 editor 激活 effect 的
  首次运行(持久化 activeTabId 非空)只确保 editor 面板存在(缺失则补建并把激活还给原活动面板),不覆盖 fromJSON
  恢复的活动面板 / 恢复期间排队打开的面板;`editorFocusPulse` 相对恢复时刻变化(用户打开 / 切换文件)才激活 editor。
  editor 会话恢复(`hydrateEditorTabs`,读文件较慢)晚于布局恢复时同样不抢:恢复以 `requestFocus: false` 打开 /
  切换 tab,不递增 `editorFocusPulse` → 活动面板仍是 Dock 恢复出的那个(editor 面板缺失则补建);恢复全部完成后
  用户 openTab / switchTab 才激活 editor。
- **恢复前的 addPanel 入口延后**(`restore-after-fromjson.spec.tsx`):`layout.read()` 较慢时 dock api 已暴露,
  恢复前 `openOrFocusPanel()` 排队、editor 自动激活等待「布局已恢复」,恢复完成后才 addPanel(不被 fromJSON 的
  `clear()` 删掉);关窗 flush 握手仍在 apiReady 时注册(时序不变)。
