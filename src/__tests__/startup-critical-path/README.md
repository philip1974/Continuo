# startup-critical-path(冷启动关键路径 · renderer)

把只依赖部分启动数据的步骤从更长的等待链上拆下来,行为保持。

## 1 — 只依赖 root 的消费方等 `rootRestored`,不等编辑器 tab 读盘

`workspace.hydrated` 在 `hydrateEditorTabs`(最多 256 tab、并发 32 读盘)完成后才置位;`rootRestored`
在 root 恢复后、tab 读盘前置位(`hydrated ⇒ rootRestored`)。`waitForWorkspaceRootRestored()` 等
`rootRestored || hydrated`(subscribe 后再查一次,防丢事件)。

- `createUserTerminal`:tab 读盘在途时即以恢复出的 root 作 cwd/workspaceRoot 发起 `terminal.create`;
  root 恢复前仍等待(不以初始 null root 创建,R10 契约不变)。(`terminal-root-gate.spec.ts`)
- `MainApp` 向 main 推 window→root 映射:root 恢复前不推(R46 契约不变),`rootRestored` 后即推最新 root,
  不等 tab 读盘。(`notify-root-gate.spec.tsx`)
