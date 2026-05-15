# 25 — explorer.json v3：per-windowSeq layout 分段持久化（架构决策）

> 类型：架构决策 / 持久化 schema 升级
> 日期：2026-05-15
> 状态：已落地（topic-08）
> 关联：topic-07（1 PTY = 1 dockview panel，doc/24）；topic-09（dock reconciler windowId filter，sibling 收尾）

## 决策

**dockview 的 panel layout 不再写独立的 `userData/layout.json`，而是按 `windowSeq` 分段嵌进 `userData/explorer.json` 的 `WindowEntry.layout` 字段；explorer.json 升至 v3 schema。**

每个 BrowserWindow 启动时通过 `BrowserWindow.fromWebContents(event.sender)?.id → getWindowSeq(windowId)` 反查自己的 windowSeq，读写专属段；多窗用户的布局完全独立。

## 上下文

topic-05 / 07 落地后,Continuo 已支持多窗(`restoreAllWindowsOnLaunch=true`),但 dockview 的 `layout.json` 仍是**全局单文件**:任何一个窗口的 `onDidLayoutChange` debounce 写盘都会**整文件覆盖**,后写的窗口把先写窗口的布局抹掉。重启后 N 个窗口拿到同一份 layout — 多窗体验事实上崩了。

workspace-isolation audit(2026-05-15,post-topic-07)把这定性为 **P0 数据丢失级问题**,与 topic-09 reconciler windowId filter 并列为多窗收尾的两个 sibling topic。

## 取舍

### 候选方案

| 方案 | 文件形态 | 评估 |
|---|---|---|
| A. 多文件 `layout-<seq>.json` | 每窗一个独立文件 | 文件数膨胀;无 atomic 原子组(LRU 摘段时多文件同步难);main 端要维护 fd 表 |
| B. **explorer.json v3 内嵌 `WindowEntry.layout`** ✓ | 单文件 + 段内字段 | 沿用既有 v2 schema(`windows[].windowSeq`),只加字段;原子写一文件管所有窗;LRU 摘段就是删段 |
| C. SQLite | 关系表 | 杀鸡用牛刀;Electron 用户数据用关系库与社区惯例背离 |

选 B。**关键洞察**:`windowSeq / windows[] / nextWindowSeq` 都是 v2 已有的语义,本质是在既有结构上加一个 `layout?: LayoutPayload`,迁移路径线性。

### v3 schema 形态

```ts
// electron/main/persistence.ts
const MAIN_OWNED_WINDOW_FIELDS = ['layout', 'lastClosedAt'] as const;

const ExplorerWritableWindowEntrySchema = z.object({
  windowSeq: z.number().int().nonnegative(),
  workspaceRoot: z.string().nullable(),
  // ... 其它 renderer-writable 字段
}).strict();  // 严格拒未知

const WindowEntrySchemaV3 = ExplorerWritableWindowEntrySchema.extend({
  layout: z.object({}).passthrough().optional(),   // ← 新增,main-owned
  lastClosedAt: z.number().int().nullable().optional(),  // ← 新增,main-owned (LRU 用)
});

const ExplorerSchemaV3 = z.object({
  version: z.literal(3),
  windows: z.array(WindowEntrySchemaV3),
  nextWindowSeq: z.number().int().positive(),
  // ... 其它顶层字段
});
```

**main-owned vs renderer-writable** 字段边界由两个 schema 强制:`explorer:write` IPC 只接 `ExplorerWritableSnapshotSchema`,renderer 无法越权写 `layout / lastClosedAt`。

### 迁移

`migrateExplorerFileToV3(file)` 处理 4 条路径:

1. **无文件** → 写 `defaultExplorerV3()`(含 `windows[0]` 最小段 + `nextWindowSeq=1`)
2. **v1 文件** → 先经既有 `migrateV1ToV2` → 再 `migrateV2ToV3`(layout=undefined)
3. **v2 文件** → `migrateV2ToV3`(所有 WindowEntry layout=undefined,不抢救旧 dockview 布局)
4. **损坏 / safeParse fail** → 退回 `defaultExplorerV3()` + 备份原文件

迁移完成后,旧 `userData/layout.json` 才被删 — **顺序严格**(S9 safeguard),避免迁移失败时双丢。

## 关键不变量

| ID | 不变量 | 实施位置 |
|---|---|---|
| INV-1 | layout 段跟 windowSeq 走,跟 workspaceRoot 完全无关 | persistence.ts mergeWritableIntoFull;IPC handler 用 windowSeq 索引 |
| INV-2 | 删 windows 段 **只能**由 main LRU / pruneLRUClosed 调用;任何 IPC 写路径(`explorer:write` / `layout:write`)**永不删段** | mergeWritableIntoFull 以 `current.windows` 为基底 patch writable 子集,current-only 段保留 |
| INV-3 | LRU 摘段时严禁摘任何活跃 windowSeq(windowId 仍在 `BrowserWindow.getAllWindows()`) | pruneLRUClosed(payload, activeSeqs, max) |
| INV-4 | windowSeq 分配必须原子(防并发新窗撞 seq) | allocateWindowSeq 在 withExplorerFileMutex 内 read-increment-write |
| INV-5 | 关窗 flush 必须等 renderer ack(或 1s 超时),才允许 `webContents.close()` 真正生效 | requestWindowFlush + ipcMain.on('layout:flush-ack') + flushedOnQuit Set |
| INV-6 | flush-ack handler 必须校验 sender(防 cross-window spoof + 防 untrusted frame) | trusted-frame check + `BrowserWindow.fromWebContents(event.sender)?.id === windowId` 双校验 |

## close flush + ack 协议

关窗时 dockview 的 `onDidLayoutChange` debounce(300ms)可能还没 fire 就被 destroy 了。close path:

```
window 'close' event (e.preventDefault)
  ↓
requestWindowFlush(win):
  ├─ pendingFlushAcks.set(win.id, done)
  ├─ setTimeout(done, 1000)       ← 兜底超时
  └─ win.webContents.send('layout:flush-request', { windowId })
       ↓
       renderer DockShell useEffect:
         ├─ saveLayout immediate (绕过 debounce)
         └─ window.electron.layout.sendFlushAck(windowId)
       ↓
       ipcMain.on('layout:flush-ack', (event, windowId) => {
         if (!isTrustedFrame(event.senderFrame)) return;       ← INV-6
         if (BrowserWindow.fromWebContents(event.sender).id !== windowId) return;
         pendingFlushAcks.get(windowId)?.();                   ← idempotent done
       })
  ↓
done():
  ├─ doneCalled flag (幂等)
  ├─ clearTimeout(timer)
  ├─ pendingFlushAcks.delete(win.id)
  └─ resolve → win.close() (真正关)
```

`flushedOnQuit` Set 在 `before-quit` 和 per-window `close` 之间共享,避免重复 flush。

## 模块拓扑

```
electron/main/
├── persistence.ts                    ExplorerSchemaV3 + migration + mergeWritableIntoFull + pruneLRUClosed + allocateWindowSeq
├── lib/
│   ├── atomic-write.ts               ← temp + rename(防 corrupt)
│   └── file-mutex.ts                 ← 单文件链式 await(防并发覆盖)
├── safe-handle.ts                    + safeHandleWithCtx / processIpcCallWithCtx (sibling,既有 50+ handler 零回归)
├── services/
│   └── window-seq.service.ts         ← windowId → windowSeq 进程内 Map
├── ipc.ts                            layout:read / layout:write / explorer:write 重写(用 ctx + writable schema)
├── ipc/window.ipc.ts                 allocateWindowSeq caller(替换 nextWindowSeqFromDisk)
└── index.ts                          requestWindowFlush + wireWindowCloseFlush + before-quit + boot migrate

src/lib/persist/
└── explorer-persist.ts               VERSION=3;writeSnapshot 构造 Writable shape(no layout/lastClosedAt)

src/shell/dock/
└── DockShell.tsx                     onFlushRequest 订阅 + sendFlushAck
```

## 测试覆盖

| spec | 锁定行为 |
|---|---|
| `src/__tests__/dock-layout-per-window-seq/persistence-v3.spec.ts` | v3 schema parse + main-owned 字段 round-trip |
| `src/__tests__/dock-layout-per-window-seq/migrate-edge-paths.spec.ts` | v1→v3 / v2→v3 / 损坏 / 缺字段 4 路径 |
| `src/__tests__/dock-layout-per-window-seq/merge-preserve-current-only.spec.ts` | INV-2 mergeWritableIntoFull 不删 current-only 段 + 保留 main-owned 字段 |
| `src/__tests__/dock-layout-per-window-seq/layout-ipc.spec.ts` | layout:read/write 用 sender 反查 windowSeq + throw-with-code 错误码 |
| `src/__tests__/dock-layout-per-window-seq/close-flush.spec.ts` | close flush + ack + cross-window spoof / untrusted frame 拒绝 + lastClosedAt 落盘 + LRU |
| `src/__tests__/dock-layout-per-window-seq/window-seq-service.spec.ts` | windowId↔seq Map 双向 + clear |
| `src/__tests__/dock-layout-per-window-seq/window-seq-allocate.spec.ts` | allocateWindowSeq 100 并发 → 100 unique seq(INV-4) |
| `src/__tests__/dock-layout-per-window-seq/file-mutex.spec.ts` | 单文件链式 await 不交叉 |
| `src/__tests__/dock-layout-per-window-seq/atomic-write.spec.ts` | temp+rename 原子;失败不留中间态 |
| `src/__tests__/dock-layout-per-window-seq/safe-handle-ctx.spec.ts` | safeHandleWithCtx + processIpcCallWithCtx |
| `tests/e2e/dock-layout-persist.spec.ts` | e2e legacy v2→v3 迁移 + IPC roundtrip(暂 `test.describe.skip`,等多实例 e2e 环境就位) |

## 删除清单(topic-08)

```
electron/main/persistence.ts:
  - saveLayout(file, payload)          ← 旧独立 layout.json 写入
  - loadLayout(file)                   ← 旧独立 layout.json 读取
  - nextWindowSeqFromDisk(file)        ← 非原子,被 allocateWindowSeq 替换

electron/main/services/window.service.ts  ← 全删(空 service)
src/__tests__/layout-persistence/          ← 全删(被 dock-layout-per-window-seq 覆盖)
```

合计 28 文件 / +2506 / -196 LOC(10 commits,40d07ac → 6c72e02)。

## 未决 / followup

1. **e2e 环境(`tests-e2e-multi-instance` 待起 topic)**:macOS 上当 packaged Continuo 仍跑时,`_electron.launch` 撞 NSApp 注册 SIGABRT。topic-08 e2e spec 写好但 skip。修法两条路:
   - 改 Playwright 用 `--user-data-dir` 完全隔离 + headless wrapper 绕开 NSApp 冲突
   - dev-loop 期间不跑 packaged Continuo,只跑 e2e 实例
2. **topic-09 dock reconciler windowId filter**:与本 topic 并列(workspace-isolation audit 标的两 sibling),修 renderer 端 reconciler 订阅过滤 — 让窗 A 创建的 terminal 不在窗 B 试图 addPanel。本 topic 不涉,sibling 独立推进。
3. **layout 写频率优化**:目前每次 onDidLayoutChange debounce 300ms 写**整个 explorer.json**。如果有多窗 + 频繁 layout 变动场景,可能 explorer.json IO 压力变大。观察后视情况引入 per-window partial write 通道。
4. **旧版 Continuo 打开 v3 文件 downgrade 行为**:v2 `.strict()` 会拒 v3 未知字段;`safeParse(v2)` fail → 该 renderer 走 default layout。可接受但 README 已标。
