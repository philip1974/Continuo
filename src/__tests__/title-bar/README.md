# TitleBar(macOS 顶栏:workspace + active file 文件名)

行为契约:**`<TitleBar />` 显示 `${activeFileName}${dirty ? ' ●' : ''}  ·  ${workspaceName}`,
没有 active 时只显示 workspace,都没有时显示 'Continuo'。具备 -webkit-app-region:drag 让用户拖窗。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/TitleBar.tsx` | UI |

## 关键行为

- 无 root + 无 active → 'Continuo'
- 仅有 root → basename(root)
- 仅有 active.filePath → basename(filePath)
- active 与 root 都有 → `${file}  ·  ${ws}`
- active.dirty=true → 文件名后追加 ' ●'
- active.filePath=null → 显示'未命名'
