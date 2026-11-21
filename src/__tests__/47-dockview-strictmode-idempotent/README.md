# 47 · dockview StrictMode idempotent applyDefaultLayout

承 topic 46 verify 阶段 user 报 dockview crash:

```
dockview-react.js:12439 Uncaught (in promise)
Error: dockview: panel with id editor already exists
  at applyDefaultLayout (layout.default.ts:8:22)
  at Object.onReady (DockShell.tsx:126:22)
```

**Root cause**: React 18 StrictMode (`main-app.ts:190`) dev mode 双 mount → `DockShell.onReady` 跑两次 → `applyDefaultLayout` 跑两次 → 第二次 `api.addPanel({id:'editor'})` throw because panel already exists。

**Fix**: `applyDefaultLayout` 加 idempotent guard (`api.getPanel('editor')` → existing 则 setActive 不 addPanel)。同样修 DockShell `restore` callback 通过 EmptyState 重复触发的场景。

## Spec

`layout-default-idempotent.spec.ts` — 双 call + 三 call 不 throw + 同一 panel ref + active 状态保持。

## 删除条件

本 spec 与 `layout.default.ts` 的 idempotent guard 共存；如 React 19 移除 StrictMode 双 mount + DockShell 重构掉双 callsite，可考虑撤回 guard 与 spec。否则**永久保留**作回归保护。
