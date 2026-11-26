# workspace-window-dedupe(同一文件夹只在一个窗口打开)

行为契约:**打开一个已在某个主窗口打开的文件夹时,聚焦那个窗口,当前窗口保持不变**(VSCode
`windowsMainService.findWindowOnWorkspaceOrFolder` → `focus` 同语义)。此前「⇧⌘N 新窗口 → 最近打开里点 ws-X」
会再开一个同一工作区的窗口(两窗互相覆盖会话、终端 cwd 回退、文件监听),原窗口也不被聚焦。

## 判定(main 统一处理)

- `electron/main/services/workspace-window-lookup.service.ts` `findWindowWithWorkspace(root, candidates)`:
  候选 = 各主窗口当前 root(`window-workspace-roots` 表);两侧先 `realpath`(软链 / 不同写法指向同一目录算同一个;
  realpath 失败用原值),再按平台语义比较(`isSameOrInsidePath` 双向 = 相等:尾分隔符无关,Windows 大小写 / 分隔符不敏感)。
  子目录 / 父目录不算同一工作区。无候选时不做 realpath。
- `electron/main/ipc/window.ipc.ts` `focusWindowWithWorkspace(root, excludeWindowId?)`:命中则还原最小化并 `focus()`。
  关窗 / 退出流程中已隐藏(不可见且未最小化)的窗口不算。
- 带工作区建的窗口(打开文件夹 / 启动恢复)在 `createMainWindow` 里立即登记 root,不等 renderer 恢复后上报 ——
  紧接着再打开同一文件夹(连点 / 连续 open-file)也能认出来。

## 入口

| 入口 | 走向 |
|---|---|
| 「最近打开」(空工作区页 / Explorer 头部菜单)`open-recent-root.ts` | renderer 先调 `window:focus-workspace-window` |
| 「打开文件夹…」(空工作区页 / Explorer 头部 / ⌘O 命令 `workbench.action.files.openFolder` / 应用菜单 ⌘O)`selectWorkspaceFolder` | 同上 |
| 拖文件夹进窗口(Explorer 以外区域)`App.tsx` | 同上 |
| 「在新窗口打开文件夹…」(命令面板 / 应用菜单 / Dock 菜单)、`window.create({ workspace })`、命令行 / `second-instance` argv、macOS `open-file`、冷启动 dock 模式的第 2 个起的目录 | main `openWorkspaceWindowWith`:命中即聚焦,不分配 windowSeq、不建窗 |

- `window:focus-workspace-window`:发起方**自己**打开的就是这个文件夹 → 返回 false(保持原行为),即使别的窗口也开着同一目录;
  别的主窗口打开了 → 聚焦它、返回 true,调用方不改本窗口 root。询问期间若又发起了新的选择(共享 `workspaceRootSelectionGuard`),
  本次作废。IPC 失败 / 拒绝按「没在别处打开」处理,打开文件夹本身不失效。
- `openWorkspaceWindowWith` 不排除发起窗口:「在新窗口打开」当前窗口已开着的文件夹 → 聚焦当前窗口,不再开第二个(VSCode 同)。

## 规范

- `find-window-with-workspace.spec.ts`:判定纯函数(realpath、子 / 父目录、尾分隔符、Windows 大小写、无候选不 realpath)
- `focus-workspace-window-ipc.spec.ts`:IPC 与新开窗口入口(聚焦 / 还原最小化 / 自身已打开 / 隐藏窗口不算 / 软链)
- `renderer-entries.spec.ts`:最近打开、打开文件夹…(含失败回退、询问期间被新选择作废)
- 拖入:`window-drop/explorer-vs-window-folder-drop.spec.tsx` ›「该文件夹已在别的窗口打开」
- 真机:`tests/e2e/workspace-window-dedupe.spec.ts`
