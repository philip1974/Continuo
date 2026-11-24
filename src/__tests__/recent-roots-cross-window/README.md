# recent-roots-cross-window(「最近打开」多窗口不互相覆盖)

缺陷:`explorer.json` 的全局段 `workspace.recentRoots` 此前由 `explorer:write` 用发起窗口的内存值整段覆盖
(`mergeWritableIntoFull` 的 `...writable`)。各窗口只在启动时 hydrate 一次、之后不重读也无广播:
A、B 两窗,A 打开 /x 落盘后盘上为 `[/x, …]`;B 任意一次落盘(展开目录、开关 tab、关窗)把盘上写回 `[…]`,
/x 丢失;B 的「最近打开」菜单也一直看不到 /x。

不能简单地在 `explorer:write` 里「本次写入列表置顶 + 盘上其余项」合并:列表满(上限 5)时,B 的陈旧满列表
置顶后会把 A 新增的 /x 挤出上限。故改为与插件授权(`plugins:mutate-plugin-permissions`)同款的**增量变更**。

## 行为契约

### main

- `promoteRecentRoot(list, path)`:`path` 置顶,其余按原顺序去重接在后面(比较键去尾分隔符、win32 大小写不敏感 ——
  升级前盘上的 `/u/proj/` 与 `C:\Proj` / `c:\proj` 视为同一项),截断到 `WORKSPACE_RECENT_LIMIT`(5,
  与 renderer `workspace.store` 同一常量)。
- IPC `explorer:touch-recent { path }`:在 explorer 文件锁内重读盘,`recentRoots = promoteRecentRoot(盘上, path)`,
  写盘后向所有窗口(含发起者)广播 `explorer:recent-changed { recentRoots }`。盘上尚无 explorer.json(首启)→
  不写不广播(由该窗口随后的 `explorer:write` 带上首份列表)。
- `explorer:write`:盘上已有文件时 `workspace.recentRoots` 是 main-owned(保留盘上值,同 `nextWindowSeq` /
  `restoreAllWindowsOnLaunch`),renderer 携带的陈旧列表不再覆盖;仅首启(盘上无文件)采用 writable 值。
- 目前**没有**「从最近列表移除一项」的入口;将来若加,须走显式删除 IPC,不能靠整表写回。
- `pinned` 同形,但目前无运行时修改入口(各窗写回的都是盘上同一份),暂不处理;加 pin/unpin 时须同样改增量。

### renderer(`src/lib/persist/explorer-persist.ts`)

- 写订阅注册后,`workspace.recentRoots` 头部变化(`setRoot` 置顶新 root)→ 立即 `touchRecent(head)`。
- 启动读盘期间用户已选 root(R38 分支)→ hydrate 后补发这些选择的 touch(旧→新,最新置顶)。
- 收到 `onRecentChanged(list)` → 以 main 列表覆盖本窗 store(main 权威、按序推送);这次 store 变化不回发 touch。

## 规范文件

- `main-touch.spec.ts`:真实临时目录 + 注册 IPC;两窗交替 touch 后盘上含双方新增项、顺序与上限;陈旧窗口
  `explorer:write` 不再覆盖盘上 recentRoots;touch 后广播给所有窗口;首启无文件不写。
- `renderer-sync.spec.ts`:`setRoot` 触发 touch;广播更新 store 且不回发;R38 启动期选择补发。
