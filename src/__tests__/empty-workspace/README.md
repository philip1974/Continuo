# EmptyWorkspace(未选 workspace 占位)

行为契约:**`<EmptyWorkspace />` 显示「打开文件夹」按钮 + 最近项。点按钮调
`coApi.fs.selectDirectory()`,选中后 `setRoot`;最近项点击直接 `setRoot(p)`。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/EmptyWorkspace.tsx` | UI |

## 关键行为

### recentRoots 空

- 不渲染最近项 menu

### recentRoots 非空

- `ul` 列表(非 menu)列出每条,行项是普通 button
- 点击 → listDir 校验后 setRoot(p);不可读 → toast,不切换
- basename 与 parent 分两段显示
- 按钮名称「名称，父路径」(无父路径时就是名称):以可见文字开头(WCAG 2.5.3 Label in Name,VSCode 最近列表同款),
  父路径区分同名目录(与资源管理器「打开最近」菜单共用 `recentRootAccessibleName`)

### 从最近列表删除(VSCode「从最近打开中删除」)

- 每条右侧 ×(悬停条目或键盘聚焦时显示,aria-label 含完整路径):删除该项,不打开
- 焦点在条目上按 Delete:同上
- 点已不存在的目录(`FS_NOT_FOUND` / `WORKSPACE_NOT_FOUND`)→ 不弹 toast,询问是否从列表删除;[删除] → 删除,[取消] → 保留
- 删除后焦点留在列表:原位置的下一项,没有则上一项;删空 → 「打开文件夹」按钮
- 删除经 `forgetRecentRoot`(main 锁内从盘上移除并广播给所有窗口,见 recent-roots-cross-window)

### 点「打开文件夹」

- 调 fs.selectDirectory()
- ok=true + data 非空 → setRoot(data)
- ok=false 或 data 空 → 不调 setRoot
- busy 期间(异步未结束)按钮 disabled,文案变「打开中…」
