# workspace-snapshot(按文件夹的会话快照)

行为契约(VSCode workspace storage:工作区状态按文件夹保存,重开 / 切回这个文件夹时恢复):

- 窗口段(`windows[]`)按 windowSeq 存,只记当前 root。此前:关掉 ws2 窗口再打开 ws2(open-file / 最近打开 / 在新窗口打开)→
  新窗口没有任何 tab、侧栏默认;同一窗口 ⌘O 切到 ws3 再切回 ws2 → 原来的 tab 没了。
- 现在 explorer.json 顶层另有 **`workspaceSnapshots`**:按 root 索引、最近使用在前,运行时最多 **20** 个文件夹(超出淘汰最旧)。
  快照 = 窗口段里与工作区相关的部分(复用窗口段 schema:`explorer` 展开 / 排序、`layoutUi` 侧栏、`editor` tab / 组 / 各组视图状态
  含折叠 / Markdown 模式 / MRU、`search` 搜索输入,外加 main-owned 的 dock `layout`),不含 windowSeq / 窗口几何 / lastClosedAt。
- main-owned:renderer 整份写回(`explorer:write`)保留盘上值;`explorer:read` 返回前剥离(renderer 不需要,且含布局)。
- root 比较:两侧先 realpath,再按平台语义比较(与同文件夹去重 `findWindowWithWorkspace` 同一判定)。
- 单个快照序列化超过 256 KiB 不存(并移除该 root 的旧快照),避免 20 份撑爆 explorer.json 的 16 MiB 读上限。

## 何时写快照

| 时机 | 内容来源 |
|---|---|
| 同一窗口切换 root 之前(⌘O / 最近打开 / 拖入文件夹 / 关闭文件夹)| renderer `setRoot` 在关掉 root 外 tab **之前**取当前状态,经 `explorer:switch-workspace` 的 `save` 送 main;dock 布局取盘上本窗段 |
| 窗口关闭(主窗 `closed`)| 盘上本窗段(关窗 flush 之后);与 lastClosedAt / 移出 `openWindowSeqs` 在同一次锁内写盘,先存快照再移除 |
| 退出(`persistWindowStates`)| 盘上各开着窗口的段(退出 flush 之后) |
| 新窗口复用 seq 0 前(冷启动 dock 模式)| 盘上原 seq 0 段先存为它自己 root 的快照,再被覆盖 |

## 何时用快照

- **新窗口**(`openWorkspaceWindowWith`:在新窗口打开文件夹 / open-file / 命令行 / second-instance / 冷启动 dock 模式):
  同文件夹去重命中 → 聚焦那个窗口,什么都不做(不分配 seq、不读写快照)。否则分配 windowSeq 后,快照表有这个 root →
  main 在锁内把快照写成该 seq 的窗口段(root = 打开的路径,并把它置顶「最近打开」、广播),以**非 fresh** 打开:renderer 按段
  恢复(含 dock 布局与其中的 popout 子窗,VSCode 辅助窗口同样随工作区恢复)。没有快照 / explorer.json 不存在或损坏 / 读写失败 →
  照旧 `fresh: true`(`?fresh=1` 语义不变:丢弃该段旧状态、以 query 的 workspace 为 root)。
- **同一窗口切换 root**:`explorer:switch-workspace` 在保存旧 root 的同时返回新 root 的快照(不含 layout);renderer 确认 root
  仍是它、且期间没有更新的切换后,恢复展开 / 侧栏 / 搜索输入 / Markdown 模式与编辑器 tab(同启动恢复:读盘失败 = 文件已删除的跳过,
  组与 dock 现有编辑器面板对齐)。dock 布局不切换(与 `dock-layout-preserved-on-root-switch` 一致:终端等面板留在窗口里)。
  没有快照 → 保持原有行为(只关掉 root 外的干净 tab)。
- 重启按窗口段恢复(`restore-windows-on-launch/`)不经快照,行为不变。

## 规范

- `snapshot-store.spec.ts`:快照表纯函数(写入置顶 / 上限淘汰 / realpath 与平台比较 / 超大不存)、合并保留、读时剥离、schema
- `snapshot-lifecycle.spec.ts`:新窗口按快照建段(非 fresh)/ 无快照 fresh / 去重命中不动 / 损坏当空;切换 IPC(存旧、取新、布局取盘上段)
- `in-window-switch.spec.ts`:renderer 切换 root 前送出旧状态、按返回快照恢复、无快照保持原行为、迟到的回复作废
- 关窗写快照在移出 `openWindowSeqs` 之前:`dock-layout-per-window-seq/close-flush.spec.ts` ›「关窗存文件夹快照」
- 真机:`tests/e2e/workspace-snapshot.spec.ts`(复现 a:关窗后再打开该文件夹;复现 b:同窗口切走再切回)
