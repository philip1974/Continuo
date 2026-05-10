# 多 window 支持(issue #23)

> 状态:**计划草案**。三档可选,边界 / 限制 / 工作量已列清,等用户拍档位再启动。

## Context

**问题**:Continuo 当前只能开一个主窗口。用户想像 VSCode 那样同时开多个,典型 use case:

1. 主窗口跑长任务,新窗口快速看另一个文件 / 跑独立 terminal
2. 同一项目两个视角(比如一个看 src,一个看 doc/wiki,各自独立 dock layout)
3. 同时开两个不同项目(类似 VSCode 的 New Window With Folder)

不同 use case 对应不同实现档位 — 工作量从半天到一周不等。

## 现状架构事实(已查证)

| 模块 | 现状 | 多 window 影响 |
|---|---|---|
| `createMainWindow()` | `electron/main/index.ts:82` 只在 `whenReady` 调一次,`activate` 仅在 `getAllWindows().length === 0` 时再开 | **无** UI 触发"开新主窗"入口 |
| `requestSingleInstanceLock()` | 已启用,二次启动只聚焦已有窗口 | 多窗必须**同进程内**开,不是新进程 |
| popout | dockview `addPopoutGroup` + `windowOpenHandler` 已支持,但只是 panel 浮出子窗 | 不能复用为主窗口路径(子窗 URL 带 `popout=1` 走 `PopoutHost` 而非 `MainApp`) |
| terminal sessions snapshot | `terminal.ipc.ts:194` 已广播给 `BrowserWindow.getAllWindows()` | ✅ 天然兼容 |
| fs watcher dir-changed | `fs.ipc.ts:155` 同款广播 | ✅ 天然兼容 |
| editor / dock layout / terminal activeId | renderer-local zustand store | ✅ 天然隔离 |
| `explorer.json`(workspace + expandedPaths + sidebarWidth + pinned) | `electron/main/ipc.ts:36` 单文件读写,`userData/explorer.json` | ⚠️ 两窗口同写互相覆盖 |
| `agent-auth.service.ts:25` `pickMainWindow()` | 永远取第一个非 popout 窗口 | ⚠️ 窗口 B 触发授权弹窗会去 A,不直观 |
| settings(`SettingsRegistry` values) | 全局共享(plugin / 内核统一注册一个 registry) | ✅ 应该共享,无需改 |
| `PluginManager` | renderer 端实例(`src/main.tsx:73`),每个 window 自己 init | 多 window 等于多套 plugin sandbox,主进程 MCP host 单例同一份。**plugin UI 注册各窗口独立**,无跨窗冲突,可接受 |
| MCP host / stdio server | main 进程单例 | ✅ 多 window 共享同 token,无需改 |
| `workspace.store` | renderer-local,假设单 workspace | 想"两窗口看不同项目"必须重写为 multi-workspace 模型 |

**关键洞察**:多 window 难度的 80% 在 `explorer.json` 和 `workspace.store` 的语义梳理,不在"开新窗口" — `createMainWindow()` 加 IPC 触发是 30 行代码的事。

## 三档方案

### 档 A — MVP(同 workspace,共享 sidebar 状态)

**语义**:menu / 快捷键 → 在已有 main process 内开新主窗;新窗口与原窗口**共享同 workspace、同 explorer.json**。

**用户体验**:
- ✅ 每窗口独立 editor tabs / dock layout / terminal active 选择
- ✅ 文件树同步两边都看得到(同 expandedPaths)
- ✅ terminal sessions 列表完全共享(任一窗口创建,两边都见,可独立 active)
- ⚠️ sidebar 收 / 展、宽度调:**两窗口互相覆盖**,后写赢
- ⚠️ agent-auth 弹窗永远到第一个开的窗口(不论是哪个窗口里的 agent 触发)

**适合 use case 1**(主窗藏背景 + 新窗口独立 terminal/editor)。

**工作量**:**半天 -1 天**。

**任务拆解**:
1. main 加 IPC `window:create` → 调 `createMainWindow()` 返回 id
2. preload 暴露 `coApi.window.create()`
3. App menu 加 "File → New Window"(Cmd+Shift+N),`menu` 路径调 IPC
4. UI 在 IconSidebar / 命令面板加可触发入口(可选)
5. BDD spec:`window-ipc` 新主题,验 IPC 能创建第二窗口、两窗口 terminal sessions 同步
6. 文档说明已知限制(sidebar 抖动 / agent-auth 路由)

**风险**:explorer.json 后写覆盖 — 用户切 sidebar 时两窗口闪烁。可通过 debounce + last-write-wins 缓解,**真正修要走档 B**。

### 档 B — 中档(同 workspace,持久化按 windowId 拆)

档 A + 解 sidebar / expandedPaths 互相覆盖问题。

**实现增量**:
- `explorer.json` 拆分:全局段(`workspace`、`pinned` 共享)+ 每窗口段(`layoutUi`、`expandedPaths` 按 windowId 索引)
- main 端给每个 window 分配 stable windowId(BrowserWindow.id 进程级唯一,关闭释放 — 可接受,不持久化跨重启)
- renderer 启动时从 `coApi.window.id()` 拿自己 id,据此读 / 写自己段
- agent-auth 路由:`requestAgentAuth(info, sourceWebContentsId?)` 改成根据触发方 webContents 找窗口

**适合 use case 1 + 2**(同项目两视角)。

**工作量**:**额外 1-2 天**(MVP + 这一档)。

**任务拆解**(在档 A 基础上):
1. `coApi.window.id()` IPC,renderer 缓存
2. `electron/main/persistence.ts` schema 升级:layoutUi/expandedPaths 改 `Record<windowId, ...>`
3. `src/lib/persist/explorer-persist.ts` 对应改读写按 windowId
4. 旧版 `explorer.json` 迁移逻辑(单段 → windowId=0 段)
5. agent-auth 加 sourceWebContentsId 路由,加"找不到对应窗口时退第一个窗口"兜底
6. spec:`explorer-persist-multiwindow`、`agent-auth-routing`

**风险**:explorer.json schema 改动需要兼容旧用户数据(简单迁移可控)。

### 档 C — 完整(独立 workspace,multi-workspace 模型)

档 B + 每个窗口可打开**不同 folder**(像 VSCode 的 File → Open Folder in New Window)。

**实现增量**:
- `workspace.store` 改成 per-window:每窗口有自己的 root,IPC 读写按 windowId 取段
- `explorer.json` 顶层 `workspace.recent` 全局共享,`workspace.current` 按 windowId 拆
- "在新窗口打开此文件夹" 命令:resolve folder 路径 → 调 `window.create({ workspace })`
- terminal sessions 现在是全局共享,可能要改成"按 workspace 过滤显示"以避免错乱(取舍)

**适合 use case 3**(同时开两个不同项目)。

**工作量**:**额外 2-3 天**(档 B + 这一档)。

**显著扩张面**:
- workspace 切换路径(目前是单窗口内切,改成开新窗)
- 命令面板 / Quick Open 的 workspace 上下文(每窗口独立)
- plugin 自己有 workspace 假设(scope plugin 当前实现可能假设单 workspace)— 要扫一遍

## BDD 主题(三档共用)

每档新增主题统一放 `src/__tests__/`:

档 A:
- `window-ipc/` — IPC `window:create` 行为契约
- `multi-window-sessions/` — 两窗口共享 terminal sessions snapshot

档 B 增量:
- `explorer-persist-multiwindow/` — schema 按 windowId 拆 + 旧文件迁移
- `agent-auth-routing/` — 触发方 webContents 路由

档 C 增量:
- `workspace-per-window/` — 每窗口独立 workspace 切换 / 持久化

每档结束跑 `pnpm bdd:index` 重生索引。

## 推荐执行档位

**已确认走档 C**(用户 use case = 同时开多个不同项目)。跳过 A/B 直接 C 比逐档升级**省一次性梳理**:档 C 的核心抽象(per-window state + explorer.json 拆段)一次定型,A 档的 hack 没必要做。

## 档 C 分阶段执行(每阶段独立 ship)

为降低风险,把档 C 拆成 4 个 Phase,每 Phase **独立 commit + 独立可用**,用户每完成一阶段都能拿到价值,不需要等全部做完。

### Phase 1 — 新窗口入口 + per-window workspace(MVP)

**用户能拿到的价值**:Cmd+Shift+N 开新窗口选另一个 folder,两窗口同时看不同项目。

**实现要点**:
- main 加 IPC `window:create({ workspace? })` → 调 `createMainWindow(opts)`,initial query string 携带 `?workspace=<encoded>`
- renderer 启动时优先读 query string 的 workspace 而非 explorer.json — 新窗口走"指定 workspace"路径,主窗口走"恢复持久化"路径
- App menu 加 "File → New Window"(空 workspace,用户进 app 后选 folder) + Cmd+Shift+N 快捷键
- 命令面板加 "在新窗口打开此文件夹"(取当前 workspace.root)
- workspace.store 已经是 renderer-local zustand,**无需改** — 每窗口天然独立

**临时妥协**:explorer.json 持久化只跟随**首个窗口**(主窗口);新开的第二个窗口状态(layoutUi / expandedPaths)不持久化,关闭后丢失。Phase 2 修。

**工作量**:**1 天**。

**任务**:
1. shared/window-channels.ts 加 `WINDOW_CHANNELS.CREATE`
2. main/services/window.service.ts 新增,封装 `createMainWindow(opts: { workspace?: string })`,query string 加 `?workspace=...`
3. main/ipc/window.ipc.ts 注册 IPC,zod 校验 workspace 路径(必须 absolute,实际存在的目录)
4. preload 暴露 `coApi.window.create`
5. main 菜单加 "New Window" + "New Window With Folder..." (后者走 dialog.showOpenDialog)
6. renderer hydrate 改:解析 query string,有 workspace 时跳过 explorer.json 主 workspace 段,用 query 值 + 空 layoutUi / 空 expandedPaths 起步
7. 命令面板加 "Open Folder in New Window"(选 folder → coApi.window.create)
8. BDD `window-ipc/`:验 IPC 创建 + workspace 入参注入到子窗 query
9. BDD `multi-window-hydrate/`:验"有 query workspace 走指定路径,无 query 走 explorer.json 持久化路径"

### Phase 2 — explorer.json schema 拆段(按 windowId)

**用户能拿到的价值**:重启 Continuo 后所有窗口的 sidebar 状态、expandedPaths 都恢复(不仅是首个)。

**实现要点**:
- `coApi.window.id()` IPC,renderer 缓存自己的 windowId(BrowserWindow.id 进程级唯一,关闭释放,跨重启不持久 — 持久化用 `seq` 自增 number)
- 持久化 schema 升级:
  ```json
  {
    "schemaVersion": 2,
    "workspace": { "recent": [...], "pinned": [...] },          // 全局共享
    "windows": {
      "0": { "workspace": "/path/to/projA", "layoutUi": {...}, "expandedPaths": [...] },
      "1": { "workspace": "/path/to/projB", "layoutUi": {...}, "expandedPaths": [...] }
    }
  }
  ```
- 旧 v1 schema 迁移:整段挪到 `windows.0`
- main 启动时读所有 `windows[*].workspace` 重新拉起所有窗口(用户重启 Continuo 自动恢复多窗口布局)
- 关闭窗口时该 windowId 段保留几个版本(LRU 上限 16)避免无限增长

**工作量**:**1-2 天**。

**任务**:
1. main/persistence.ts schema v1 → v2 迁移(单段挪到 `windows.0`,加 `schemaVersion: 2`)
2. main/services/window-id.service.ts:管理 windowId 分配、windows 段读写
3. `window:id()` IPC + preload + coApi
4. renderer hydrate:从 `coApi.window.id()` 拿 id,读自己段
5. 启动时若 `windows` 段有多条,main 全部 createMainWindow(每个用各自 workspace)
6. 关闭窗口:可选保留段(LRU)
7. BDD `explorer-persist-v2-migration/`:旧 v1 文件升级到 v2 不丢数据
8. BDD `multi-window-restore/`:多窗口启动时全部恢复

### Phase 3 — agent-auth 路由到触发方窗口

**用户能拿到的价值**:在窗口 B 里跑 agent 触发授权,弹窗到 B 而不是 A。

**实现要点**:
- `requestAgentAuth(info, sourceWebContentsId?)`:从 IPC 调用方拿 `event.sender.id`,据此找对应 BrowserWindow
- 找不到对应窗口(比如窗口已关)→ fallback 第一个非 popout 窗口(原行为)
- IPC 入口拿 sender.id 注入到 `requestAgentAuth`

**工作量**:**半天**。

**任务**:
1. `terminal.ipc.ts` 在 IPC handler 里把 `event.sender.id` 带进 `makeCreateHandler` 的 deps
2. agent-auth.service.ts 改 `requestAgentAuth(info, fromWebContentsId?)`:优先用 fromWebContentsId 找窗口
3. BDD `agent-auth-routing/`:验 webContentsId 路由 / 找不到时 fallback

### Phase 4 — 多 workspace 命令面板上下文(polish)

**用户能拿到的价值**:Quick Open / Command Palette 在窗口 B 只搜窗口 B 的 workspace,不串。

**实现要点**:
- 当前 Quick Open 已经基于 renderer-local workspace.root,**多窗口天然独立** — Phase 4 主要是**审视有没有意外的全局共享**:
  - command palette 注册的 plugin commands(全局,共享 OK)
  - quick-open 文件索引(每窗口自己跑 `fs.listDir(root)`,天然独立 ✓)
  - 命令"打开最近 workspace":列表是全局共享(workspace.recent),点击走 per-window workspace 切换
- 检查 plugin scope 是否假设单 workspace(`scoped-app.ts` 等)

**工作量**:**半天**(主要是审视 + 改少量假设)。

**任务**:
1. grep 全局对 `workspaceRoot` / `workspace.root` 的引用,确保没"暗持久化"到 main 的全局变量
2. plugin sandbox 审视:`coApp` 上的 workspace 引用是 per-renderer 的 ✓ 验证
3. BDD `multi-window-quickopen/`:两窗口分别看 projA/projB,各自 Quick Open 只列自己 workspace 的文件

### 累计工作量

| Phase | 工作量 | 累计 ship |
|---|---|---|
| 1 | 1 天 | 能开多窗看不同 folder(不持久化第二窗) |
| 2 | 1-2 天 | 重启后多窗状态全恢复 |
| 3 | 0.5 天 | agent-auth 弹对窗口 |
| 4 | 0.5 天 | 完整体验 polish |
| **总计** | **3-4 天** | 完整 multi-workspace |

## 显式不做(留后续)

- **跨窗口 dock layout 同步**:VSCode 也不做,每窗口独立 layout 是预期。
- **跨窗口快捷键焦点路由**:Electron 默认每窗口独立 keydown,不需特殊处理。
- **窗口大小 / 位置持久化按窗口拆**:档 A/B 都用 Electron 默认,所有新窗口同款初始尺寸。Phase 2 可加。
- **Window 菜单(切换 / 重新排列已开窗口)**:macOS 默认有 Window 菜单,够用。

## 关键文件锚点(实施时直接看)

- `electron/main/index.ts:82-100` — `createMainWindow()`(档 A 复用)
- `electron/main/index.ts:155-169` — `single-instance` 处理(不冲突,新主窗在已有进程内开)
- `electron/main/services/agent-auth.service.ts:25` — `pickMainWindow()`(档 B 改)
- `electron/main/ipc.ts:36-54` — `explorer:read/write` 单文件路径(档 B 拆段)
- `src/lib/persist/explorer-persist.ts` — renderer hydrate(档 B 同步改)
- `src/stores/workspace.store.ts` — workspace 单例(档 C 改 per-window)
