# StatusBar(底部 24px 状态栏)

行为契约:**左:workspace basename + 占位 git 分支(main) + 「侧栏已隐藏」hint(sidebarOpen=false 时);
右:active editor 文件名(+dirty ● 圆点) + 行/词/字符/UTF-8/LF;无 active → 仅 UTF-8。
agent terminal 数量 > 0 → 显示「N agent」按钮(点击 confirm 后 revoke + IPC revoke)。
「复制 MCP 配置」按钮调 coApi.mcp.getStdioConfig + clipboard。
插件 statusBar items 按 side('left'/'right')分别渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/StatusBar.tsx` | UI |
| `src/lib/text-stats.ts` | line/word/charCount(已测) |
| `src/plugins/registries/StatusBarRegistry.ts` | 插件 statusBar items |

## 关键行为

### 工作区与 sidebar

- root 缺 → 「无工作区」
- root 有 → basename + 「main」(git 占位)
- sidebarOpen=false → 显示「侧栏已隐藏」

### 右侧文件信息

- activeTab=null → 只显示「UTF-8」
- activeTab + filePath → basename + dirty ●(active.dirty=true 时)
- 行/词/字符 来自 text-stats
- UTF-8 + LF 占位

### agent 计数

- sessions 中 originHint='agent' 数 > 0 → 显示按钮「N agent」+ ● 标记

### 插件 items

- coApp.statusBar 中 side='left' → 在 root 之后
- side='right' → 在 MCP 按钮之前

### MCP 复制

- 点按钮 → coApi.mcp.getStdioConfig + writeText
- ok → 文案变「已复制」1.5s 后回归
- ok=false 或 unavailable → 文案变「MCP 不可用」/「复制失败」
