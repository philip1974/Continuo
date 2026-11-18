# explorer-expanded-state

行为契约:**Explorer 的持久化展开状态接入 headless-tree**。

## 关键行为

- `FolderTree` 从 `useExplorerStore.expandedPaths` 恢复展开状态。
- root 始终作为 headless-tree 的 expanded item 注入,否则根 children 不会加载。
- 不属于当前 root 的持久化 path 不注入当前树。
- headless-tree 的 `setExpandedItems` 会写回 `useExplorerStore.expandedPaths`,供窗口持久化层保存。
- 「全部展开」期间库逐目录 expand 的回写合并为批次末尾一次写 store(避免 O(D²));批量期树的受控 state 用库最新值,不被 store 旧值覆盖;最终展开集合与逐步回写一致,out-of-root 段保留。
- 批量期 fs watcher 跟随树实际展开集合(而非 store),批中新展开目录即刻装 watcher(Linux watcher 非递归,否则批中变化永久漏掉)。

## 覆盖

- `folder-tree-expanded-state.spec.tsx`:mock `useTree` 捕获配置,验证 `state.expandedItems` 与 `setExpandedItems` 接线。
- `folder-tree-expand-all-batch.spec.tsx`:真 headless-tree 驱动「全部展开」,验证批末单次写 store 与最终集合。
- `folder-tree-expand-all-watcher.spec.tsx`:挂起某目录 listDir 使批次未结束,验证已展开目录的 watcher 已安装、store 仍未写。
