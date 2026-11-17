# ExplorerSidebar(VSCode 风固定侧边栏)

行为契约:**`<ExplorerSidebar />` 在 `sidebarOpen=true` 时挂出,宽度由 store.sidebarWidth 控制;
右边 4px 拖拽条调用 useColumnResize 改宽度。`sidebarOpen=false` → 整个组件不渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/ExplorerSidebar.tsx` | UI |
| `src/stores/layout-ui.store.ts` | sidebarOpen/Width state |

## 关键行为

### sidebarOpen=false

- 不渲染(返 null)

### sidebarOpen=true

- 渲染 <aside style={ width }>
- 内含 <Explorer />(无 workspace 时为 EmptyWorkspace)
- 拖拽条 div(cursor-col-resize)

### 宽度变化的渲染隔离(perf)

- 拖拽/键盘改 sidebarWidth 只重渲侧栏外壳(aside 宽度、separator aria-valuenow)
- `Explorer`(memo,无 props,只订阅 workspace root)及其 FolderTree 子树不因宽度变化重渲
- root 变化仍驱动 Explorer 重渲
- 规范:`explorer-sidebar-render-isolation.spec.tsx`
