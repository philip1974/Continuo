# ExplorerSidebar(VSCode 风固定侧边栏)

行为契约:**`<ExplorerSidebar />` 在 `sidebarOpen=true` 时挂出,宽度由 store.sidebarWidth 控制;
右边 4px 拖拽条调用 useColumnResize 改宽度。`sidebarOpen=false` → 用户看过的文件树保持挂载但隐藏
(aside `hidden`),其余情况不渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/ExplorerSidebar.tsx` | UI |
| `src/stores/layout-ui.store.ts` | sidebarOpen/Width state |

## 关键行为

### sidebarOpen=false

- 从未对用户显示过文件树(启动即关闭 / 首帧 root 未 hydrate 而 hydrate 后关闭 / 无 workspace)→ 不渲染(返 null)
- 打开过且 root 未变 → 保活:aside `hidden`,FolderTree 不卸载(不 unwatchDir,重开不重新 listDir/watchDir,
  滚动位置保留);拖拽条与宽度订阅卸载;`ExplorerVisibleContext=false` 下传
- 隐藏期间换 root → 卸载旧树、不在隐藏态挂载新树,直到再次打开
- 规范:`explorer-sidebar-keepalive.spec.tsx`

### sidebarOpen=true

- 渲染 <aside style={ width }>
- 内含 <Explorer />(无 workspace 时为 EmptyWorkspace)
- 拖拽条 div(cursor-col-resize)

### 宽度变化的渲染隔离(perf)

- 拖拽/键盘改 sidebarWidth 只重渲侧栏外壳(aside 宽度、separator aria-valuenow)
- `Explorer`(memo,无 props,只订阅 workspace root)及其 FolderTree 子树不因宽度变化重渲
- root 变化仍驱动 Explorer 重渲
- 规范:`explorer-sidebar-render-isolation.spec.tsx`
