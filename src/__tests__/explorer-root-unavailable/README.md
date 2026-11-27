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
- 编辑器侧(打开的 tab 标「(已删除)」与恢复、自动保存暂停提示)见 `editor-orphaned-tab`。

## Modules

| File | Role |
|---|---|
| `src/panels/Explorer/hooks/useRootPresenceRefresh.ts` | 订阅根存在性变化、根读取失败期间低频复查 |
| `src/panels/Explorer/FolderTree.tsx` | 接入(刷新根 = refreshParent(root),整树 = refreshAll) |
| `root-presence-refresh.spec.tsx` | 上述契约 |
| `tests/e2e/explorer-volume-unmount.spec.ts` | 真实 Electron + 小 dmg:卸载期间显示根读取失败,挂回后列表与已删除 tab 恢复、自动保存恢复 |
