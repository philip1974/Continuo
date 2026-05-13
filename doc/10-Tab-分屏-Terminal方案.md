# 10 · Tab 分屏 Terminal 方案

> issue #26 — 自由分屏 + 拖拽重排 terminal panel + 重启恢复 PTY/cwd
> 落地版本:topic 02-tab-split-panes(2026-05-13)
> 详 audit trail:`.claude/dev-loop/02-tab-split-panes/`(req / plan-v1..v4 / red-team-v1..v3 / execute-log / verify)

## 1 · 目标

每 tab 内自由分屏 terminal panel(VSCode/iTerm 同款),每 split pane = 单 PTY,支持嵌套 + 拖拽重排;重启后 layout + cwd 完整恢复;**popout 子窗禁分屏**(单 panel 焦点窗口语义)。

不在 scope:editor 混合分屏;跨 tab 拖 panel 重组;自定义 panel 类型。

## 2 · 核心架构选择

### 2.1 一个 DockviewReact 实例 + 自实现内层 tabs

项目全局**只一个** `<DockviewReact>`(`src/shell/dock/DockShell.tsx:156`),`TerminalTabs.tsx` 是自实现 React 组件用 `@/design TabNav`,**不是嵌套 dockview**。

分屏调 `dockview.containerApi.addPanel({position: {referenceGroup, direction}})` 加 panel,不是新开 dockview 实例。架构层不会冲突。

### 2.2 TerminalPanel 双模式(scoped vs legacy)

`TerminalPanel.tsx` 加 `params?: IDockviewPanelProps<TerminalPanelParams>`:
- `params.sessionId` 存在 → 只渲染 `<TerminalView termId={sessionId} />`(scoped 模式)
- `params.cwd` 但无 sessionId → mount effect 自 hydrate(`coApi.terminal.create({cwd, scoped: true})` → `props.api.updateParameters({sessionId})`)
- 无 params → 走原 legacy 路径(全 sessions list + 自实现 TerminalTabs)— 向后兼容 S1

**scoped 早返回**:在任何 `useTerminalStore` 订阅之前 `return`,避免 hook tree 污染全局 store。

### 2.3 (β) scoped flag 数据层隔离

`MainTerminalSession.scoped?: boolean` 字段 + `splitTerminal` 创建时 `scoped: true`。`TerminalTabs` filter `!s.scoped`(用 useMemo 避 selector re-render):

```ts
const allSessions = useTerminalStore((s) => s.sessions);
const sessions = useMemo(() => allSessions.filter(x => !x.scoped), [allSessions]);
```

**防止同 PTY 双 view + 输入交织**:scoped panel(由 split 创建)与 legacy panel(无 params 走旧路径)共存时,scoped session 不出现在 legacy 内层 tab list,避免两个 `<TerminalView termId="X">` 渲染同一 PTY 导致输入合并乱序。

## 3 · 关键改动点

### 3.1 `lazyPanel<P>(props?: unknown) => ReactNode`(P0-1 props 链)

之前 `lazyPanel(Component)` 返回 `() => ReactNode`,DockShell 调 `Factory(p)` 时丢 props。改:

```ts
export function lazyPanel<P = unknown>(
  Lazy: ComponentType<P>,
  fallback: ReactNode = null,
): (props?: unknown) => ReactNode {
  return function LazyPanel(props?: unknown) {
    return createElement(Suspense, { fallback }, createElement(Lazy, (props ?? {}) as P));
  };
}
```

返回参数用 `unknown`(不是 `P`)兼容 PanelRegistry 的 `(props: unknown) => ReactNode` 契约 — 5 处既有无参 plugin 调用(`PluginsTabPlugin/KeybindingsTabPlugin/SettingsPanelPlugin/EditorPlugin/TerminalPlugin`)仍 typecheck 通。

### 3.2 `wrap-panel-close` close hook(P0-1 替代 onWillRemove)

dockview `panel.api` **没有** `onWillRemove`(red-team-v3 grep `dockviewPanelApi.d.ts` 实证只有 `close/setTitle/setRenderer/moveTo`)。改用 close 拦截器:

`src/shell/dock/wrap-panel-close.ts` `wrapPanelClose(panel)` 在 close fn 内:
- `panel.api.id.startsWith('terminal-')` AND `panel.params.sessionId` 存在 → 调 `coApi.terminal.remove(sessionId)`
- 然后正常 `setTimeout(original, EXIT_DURATION_MS)` 走原退场动画

用 `terminal.remove`(删 metadata + kill PTY + buffer.destroy),不是 `terminal.kill`(只杀进程留 zombie metadata)。

### 3.3 Layout JSON 不存 sessionId,migrate sanitize(P0-2)

sessionId 是 volatile(in-memory Map,重启即死)。layout JSON 改存 `{cwd, title, role}`:

- `splitTerminal` `addPanel` 时 params 写 `{sessionId, cwd, title, role: 'split'}` — sessionId 给 in-memory 用
- 重启 hydrate:`DockShell` `fromJSON` 前调 `sanitizePersistedDockLayout` strip `terminal` 类 panel 的 `params.sessionId` → 启动后 `TerminalPanel` 看见 `params.cwd` 无 sessionId → 走 hydrate effect 重 spawn PTY → `updateParameters({sessionId: newId})` 注入新 id

### 3.4 Shell-integration env 注入(P0-2 cwd tracking)

`/etc/zshrc_Apple_Terminal` 有 OSC 7 precmd,但 PTY env 强设 `TERM_PROGRAM='Continuo'`,**默认 OSC 7 在 Continuo 内不启用**(red-team-v3 grep 实证)。

解:**主动注入 shell-integration**(VSCode 同款路径):

| Shell | 注入方式 | env |
|---|---|---|
| zsh | 临时 dir `${tmpDir}/.zshrc`(source 用户原 + `chpwd_functions+=(_continuo_osc7)`)| `ZDOTDIR=tmpDir` + `_CONTINUO_USER_ZDOTDIR=$HOME` |
| bash | `${tmpDir}/.bashrc`(source 用户原 + `PROMPT_COMMAND='_continuo_osc7; ...'`)| `BASH_ENV=rcfile` + `ENV=rcfile` + `_CONTINUO_USER_BASH_RC=~/.bashrc` |
| fish | `${tmpDir}/fish/conf.d/_continuo.fish`(`function _continuo_osc7 --on-variable PWD`)| `XDG_CONFIG_HOME=tmpDir` + `_CONTINUO_USER_FISH_CONFIG=$HOME/.config/fish/config.fish` |
| 其他 | 无注入(degrade,cwd 仍 spawn-time)| baseEnv 不变 |

PTY exit 时 `fs.rm(tmpDir, recursive)` 清理。

### 3.5 OSC 7 handler 在 xterm renderer 侧(P0-4 cwd 上报)

`useTerminal.ts` 注册:

```ts
const dispose = xterm.parser.registerOscHandler(7, (data) => {
  try {
    const m = /^file:\/\/([^/]*)(\/.*)?$/.exec(data);
    if (!m) return true;
    const [, host, encPath] = m;
    if (host && host !== 'localhost') return true;   // 远程 SSH reject
    if (!encPath) return true;
    void coApi.terminal.updateCwd(termId, decodeURI(encPath));   // try/catch by outer
  } catch { /* malformed,ignore */ }
  return true;
});
```

main 侧 `terminalSessions.updateCwd(id, cwd)` 写回 store 并 notify subscribers。

### 3.6 `before-quit` per-window flush handshake(P0-3)

`coApi.layout.write` 是 `ipcRenderer.invoke` 异步,renderer 销毁不等 Promise。改:

main `app.on('before-quit')`:
```ts
let flushDone = false;
app.on('before-quit', async (e) => {
  if (flushDone) return;
  e.preventDefault();
  flushDone = true;
  const wins = BrowserWindow.getAllWindows();
  const ackPending = new Set(wins.map(w => w.id));
  await Promise.race([
    new Promise<void>((resolve) => {
      const onAck = (_, winId) => {
        ackPending.delete(winId);
        if (ackPending.size === 0) { ipcMain.off('layout:flush-ack', onAck); resolve(); }
      };
      ipcMain.on('layout:flush-ack', onAck);
      for (const w of wins) w.webContents.send('layout:flush-request');
    }),
    new Promise<void>(r => setTimeout(r, 1500)),   // timeout 兜底
  ]);
  void mcpHost?.close().catch(() => {});
  void mcpStdio?.close().catch(() => {});
  app.quit();   // flushDone 防二次 emit
});
```

renderer 收 `layout:flush-request`:`await coApi.layout.write(api.toJSON()); window.electron.layout.sendFlushAck(windowId)`。

window id 通过 sync IPC `window:id`(`sendSync`)从 preload 反查(BrowserWindow.id 构造前不可读)。

`onDidLayoutChange` 现有 300ms debounce **保留**(P1-4)— 日常分屏不去 debounce,只 before-quit 走 immediate flush。

## 4 · Trade-offs

### 接受的复杂度

| 增项 | 必要性 |
|---|---|
| shell-integration 3 snippet + 临时 rcfile dir | OSC 7 默认不启用是 Continuo 自己设的 TERM_PROGRAM=Continuo 副作用,绕回去必须 |
| before-quit per-window handshake | 多窗 layout 不同步 / 异步 invoke 不可等都是真问题 |
| `lazyPanel<P>` generic 转发 + cast 回 unknown | dockview 注 props 需求 vs PanelRegistry unknown 契约 必须兼容 |
| layout JSON migrate sanitize | 旧 layout 含死 sessionId,启动炸是 UX 灾难 |
| `MainTerminalSession.scoped` + TerminalTabs filter | scoped + legacy 共存时同 PTY 双 view 是真 bug(输入交织) |

### 拒绝的复杂度

| 否决项 | 理由 |
|---|---|
| 新建 `TerminalSessionPanel`(独立 dockview component type) | 改 TerminalPanel 加 scoped 分支 = 1 个 component 2 条路径,迁移 layout JSON 免;否则旧 layout `terminal` panel 需要 migration 到新 type,scope 涨 |
| layout JSON 存 sessionId 启动 lookup | 治标不治本,跨会话 sessionId 全失效 |
| sendSync 同步 flush 到主进程 | renderer-side sendSync 死锁风险高 |
| 引入 lucide icon library | 项目无 lucide 依赖,popout button 是 inline SVG + IconButton 包裹的惯例 — 引入新 lib 违 N3 极简 |
| 主动改 tmux config | OSC handler 端兼容 DCS-wrapped(xterm 默认 strip 后到 handler 是裸 payload)即可;不动用户环境 |

## 5 · 关键文件

### Renderer

- `src/lib/lazy-panel.tsx` — `<P>` generic + `(props?: unknown)` 返回
- `src/lib/split-terminal.ts` — `splitTerminal(direction)` helper
- `src/core-plugins/TerminalPanelPlugin.ts` — `terminal.splitRight` (`mod+\`) / `terminal.splitDown` (`mod+shift+\`) commands
- `src/core-plugins/TerminalPlugin.ts` — `lazyPanel<IDockviewPanelProps<TerminalPanelParams>>(Terminal)` 应用泛型
- `src/panels/Terminal/TerminalPanel.tsx` — scoped + hydrate + cancelled cleanup
- `src/panels/Terminal/TerminalTabs.tsx` — `filter !scoped` via useMemo
- `src/panels/Terminal/useTerminal.ts` — OSC 7 handler + host 校验 + try/catch
- `src/shell/dock/DockShell.tsx` — `sanitizePersistedDockLayout` + flush-request listener
- `src/shell/dock/HeaderActions.tsx` — 2 IconButton(split right/down)+ popout hide
- `src/shell/dock/wrap-panel-close.ts` — close 前 scoped PTY remove hook
- `src/stores/terminal.store.ts` — `TerminalSession.scoped?: boolean`

### Main

- `electron/main/services/terminal-sessions.service.ts` — `scoped` field + `updateCwd` API
- `electron/main/services/terminal.service.ts` — async `createTerminal` + `prepareEnv` 集成 + `shellCleanup`
- `electron/main/services/shell-integration.ts` — `detectShell` + `prepareEnv` 主入口
- `electron/main/services/shell-integration-snippets/{zsh,bash,fish}.{sh,sh,fish}` — 3 shell hook 模板
- `electron/main/ipc/terminal.ipc.ts` — `session:update-cwd` handler + create schema 加 `title?`/`scoped?` + async wrapper
- `electron/main/index.ts` — `before-quit` per-window ack handshake + sync IPC `window:id`/`system:hostname`
- `electron/preload/index.ts` — `terminal.updateCwd` / `layout.onFlushRequest` / `layout.sendFlushAck` / `system.windowId`/`system.hostname`

## 6 · 验证

- **24 BDD spec**(`src/__tests__/tab-split-panes/`)全绿
- **typecheck** 4 conf 全过
- **smoke regression**(`agent-terminal-mcp / window-aware-agent-session / terminal-sessions-service / terminal-ipc / terminal-panel` 5 套件)386 passed,**#18 / #24 / #28 / #29 全保留**
- **GUI real-test** scenarios DEFERRED 手测(topic 01 precedent — 信任代码层)

## 7 · 后续可改

- 上游 dockview API 加 `onWillRemove` / `onWillClose` 后,wrap-panel-close 可去掉,直接用 PanelApi event(更干净)
- Computer Use 跑 real-test gate 6 scenarios + screenshot evidence(skill 已装,只是 topic 没 spent time 跑)
- shell-integration 模式扩 PowerShell(Windows users)
- tmux `allow-passthrough on` 不开时,degrade 提示 UX(目前是 silent,split 用 spawn-time cwd)

## 8 · Dev-loop 过程

- /dl-req → req.md(complexity: major)
- /dl-plan v1 → /dl-red-team v1 BLOCK(1P0:架构假设错,TerminalPanel 不是单 PTY 容器)
- /dl-plan v2 → /dl-red-team v2 BLOCK(4P0:props 链 / sessionId 死 / flush 失效 / spawn-time cwd)
- /dl-plan v3 → /dl-red-team v3 BLOCK(2P0:onWillRemove 不存在 / OSC 7 被 TERM_PROGRAM 屏蔽)
- **D.3 round 3 极限 + manual_override** → /dl-integrate plan-v4(接口替换,不算新 round)
- /dl-execute 17 ops 全绿
- /dl-verify PASS(real-test DEFERRED 手测)

议题 D.3 manual override 路径成立:plan↔red-team 极限不是 dead end,如果剩余 P0 是接口替换(not 设计方向错),integrate 可以接住。
