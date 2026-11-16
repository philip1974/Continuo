# dock-reconciler-api-rebuild — dock api 变化 / 布局恢复后终端 panel 全量重建

终端 panel 不从持久化布局恢复,只由 `DockReconciler` 依 live session 列表建出。

## 行为契约

- **api 重建**(`api-rebuild.spec.tsx`,R26):dock api 变更(dockview 重建 / onReady 重入 / HMR /
  StrictMode)= 全新空 dock → 现有 session 全部在新 api 重建(不沿用上个 api 的 diff 基线)。
- **异步布局恢复**(`restore-after-fromjson.spec.tsx`):`DockShell` onReady 在 `await layout.read()`
  之后才 `fromJSON`(dockview 内部先 `clear()`)。Reconciler 推迟到布局恢复(fromJSON / 默认布局)完成后
  才挂载 → 恢复完成时现有终端 session 仍各有 panel,不被 fromJSON 清掉;之后新增的 session 照常建 panel。
