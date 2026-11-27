# explorer-root-unavailable(工作区根不可用 / 恢复时资源管理器不显示过期列表)

## 背景

工作区根在可移动卷上(dmg、U 盘、网络盘)时,`hdiutil detach` 后资源管理器仍列出卸载前的全部文件;挂回后有时停在空列表。
macOS FSEvents 的根事件与卷实际状态不同步:卸载事件可能早于挂载点被删除,挂回时先到的事件对应空挂载点(卷内容未就位),
之后不一定再有事件。

## 行为

- main(`createRootPresenceTracker`,见 `editor-orphaned-tab/root-presence-main.spec.ts`):根事件(filename = 根 basename,
  或不带 filename 的根级事件,或 watcher error)当下 stat 一次,并在 `ROOT_PRESENCE_SETTLE_MS` 后再复查一次;
  消失 / 恢复都推 `fs:root-presence-changed`,恢复后的延迟复查再推一次。
- 资源管理器(`useRootPresenceRefresh`):
  - 收到本根的 `fs:root-presence-changed` → 先 `listDir(根)` 探测:读得到 → 整树刷新(根 + 已展开目录);
    读不到 → 只刷新根 → 根读取失败的内联提示(原因 + 重试)取代过期列表。别的根的事件不处理。
  - 根处于读取失败状态时每 `ROOT_UNAVAILABLE_RECHECK_MS` 一次 + 窗口获得焦点时探测根,读得到即整树刷新(不依赖挂回事件)。
    根正常时不轮询。
- **卷挂在固定目录上**(`hdiutil attach -mountpoint <已有目录>`、NFS / SMB / sshfs 挂在用户目录下):卸载后挂载点目录还在(空目录),
  「根存在」不变,只有根目录的 dev / ino 变;卸载 / 挂回实测没有任何 fs 事件。main 每次检查根(根事件当下 / 延迟复查 / 窗口获焦 /
  窗口设定工作区根时记基线)都比对 dev / ino:与上次看到的不同 → 推 `fs:root-presence-changed`(延迟复查时再推一次),资源管理器按上面
  的规则整树刷新(卸载期间显示空的挂载点目录,挂回后显示卷内容);同时**重建**该根及其下已展开目录的 watcher(卷换了,旧 watcher
  可能已失效),重建失败的按失效驱逐并通知持有者重装。首次看到的身份只作基线,不推送。
- 编辑器侧(打开的 tab 标「(已删除)」与恢复、自动保存暂停提示)见 `editor-orphaned-tab`。

## Modules

| File | Role |
|---|---|
| `src/panels/Explorer/hooks/useRootPresenceRefresh.ts` | 订阅根存在性变化、根读取失败期间低频复查 |
| `src/panels/Explorer/FolderTree.tsx` | 接入(刷新根 = refreshParent(root),整树 = refreshAll) |
| `root-presence-refresh.spec.tsx` | 上述契约 |
| `electron/main/ipc/fs/watch.ts` | `createRootPresenceTracker`(存在性 + dev / ino 身份比对)、`createWatcherPool.recreate`(按原路径重建 watcher) |
| `electron/main/ipc/fs.ipc.ts` / `electron/main/index.ts` | 生产接线:身份 = `stat(bigint)` 的 `dev:ino`;设定工作区根时记基线(`setWorkspaceRootListener`);`browser-window-focus` → `checkWindowRootPresence` |
| `root-identity-change.spec.ts` | 身份比对、watcher 重建、生产接线(同一路径换成另一个目录 + 获焦) |
| `tests/e2e/explorer-volume-unmount.spec.ts` | 真实 Electron + 小 dmg:卸载期间显示根读取失败,挂回后列表与已删除 tab 恢复、自动保存恢复;固定挂载点:卸载后获焦不再列旧文件,挂回后获焦列出卷内容、之后外部新建的文件照常出现 |
