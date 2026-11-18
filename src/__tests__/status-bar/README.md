# StatusBar(底部 24px 状态栏)

行为契约:**左:workspace basename + 「侧栏已隐藏」hint(sidebarOpen=false 时);
右:active editor 文件名(+dirty ● 圆点) + 行/词/字符;无 active → 不显示文件信息。只显示真实信息,不放写死的占位(分支名 / 编码 / 换行)。
agent terminal 数量 > 0 → 显示「N agent」按钮(点击 → design Modal 确认框,确认后 revoke + IPC revoke;不用原生 window.confirm)。IPC revoke 成功 → 清掉 renderer 仍显示的 agent 授权弹窗(以 `'cancelled'` 结算,应答方不再向 main respond;main 撤销时已结算并删除全部 pending 请求)。
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
- root 有 → basename
- sidebarOpen=false → 显示「侧栏已隐藏」

### 右侧文件信息

- activeTab=null → 不显示文件信息
- activeTab + filePath → basename + dirty ●(active.dirty=true 时)
- 行/词/字符 来自 text-stats

### agent 计数

- sessions 中 originHint='agent' 数 > 0 → 显示按钮「N agent」+ ● 标记

### 插件 items

- coApp.statusBar 中 side='left' → 在 root 之后
- side='right' → 在 MCP 按钮之前

### MCP 复制

- 点按钮 → coApi.mcp.getStdioConfig + writeText
- ok → 文案变「已复制」1.5s 后回归
- ok=false 或 unavailable → 文案变「MCP 不可用」/「复制失败」

## 无 agent 会话时的授权撤销入口(终审 P1)

- 只授予了调试域(外部 MCP 客户端 `debug.launch` → 本次启动期间允许)或终端域,但当前没有 agent terminal 时,
  状态栏仍显示撤销入口(文本「Agent 已授权」,带 `data-agent-revoke`),确认后撤销终端 / 调试 / 插件工具三个域的授权
  (调试授权等同任意代码执行,不能只能靠退出应用撤销)。
- 既无 agent 会话也无任何授权时不显示入口。
- 无会话时确认框用 `permissions.revoke_all.confirm_grant_only` 文案(不提「终止 N 个 terminal」)。
- 该确认文案与撤销入口提示 `statusbar.agent_revoke_grant_tooltip` 在 en / zh / ko 中都须列出插件工具域。
