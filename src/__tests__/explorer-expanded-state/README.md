# explorer-expanded-state

行为契约:**Explorer 的持久化展开状态接入 headless-tree**。

## 关键行为

- `FolderTree` 从 `useExplorerStore.expandedPaths` 恢复展开状态。
- root 始终作为 headless-tree 的 expanded item 注入,否则根 children 不会加载。
- 不属于当前 root 的持久化 path 不注入当前树。
- headless-tree 的 `setExpandedItems` 会写回 `useExplorerStore.expandedPaths`,供窗口持久化层保存。

## 覆盖

- `folder-tree-expanded-state.spec.tsx`:mock `useTree` 捕获配置,验证 `state.expandedItems` 与 `setExpandedItems` 接线。
