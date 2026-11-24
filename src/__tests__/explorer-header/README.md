# ExplorerHeader(FolderTree 顶部 Header)

行为契约:**显示当前 root 的 basename(title 完整路径)。hover 显示新建文件 / 新建文件夹 /
刷新 / 折叠全部 IconButton 条(对应 prop callback 才渲染)。⋯ 溢出菜单(常驻)
含展开全部 / 最近打开列表 / 切换文件夹 / 关闭文件夹。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/ExplorerHeader.tsx` | UI |
| `src/stores/workspace.store.ts` | recentRoots / setRoot |

## 关键行为

### 标题

- 显示 basename(root)
- title 属性是完整 root

### Hover 工具条

- onNewFile 缺 → 不渲染
- onNewFile 提供 → IconButton aria-label='新建文件',点击调 fn
- 同样 onNewDir / onRefresh / onCollapseAll

### ⋯ 菜单

- 默认 menuOpen=false
- 点击 ⋯ → 切换 menuOpen
- menuOpen=true → role=menu 渲染
- 「展开全部」disabled=!onExpandAll;点击 → onExpandAll() + 关菜单
- 「切换文件夹…」点击 → fs.selectDirectory + setRoot
- 「关闭文件夹」点击 → setRoot(null) + 关菜单
- 文档 pointerdown 在 wrap 外 → 关菜单

### 最近打开

- recentOthers = recentRoots 排除当前 root
- 空 → 不渲染「打开最近」分组
- 非空 → 列出每条,点击即关菜单(焦点还原),再经 `openRecentRootOrNotify` 用 listDir 校验:可读 → setRoot(path);不可读 → 报错且不切换;
  目录已不存在(`FS_NOT_FOUND` / `WORKSPACE_NOT_FOUND`)→ 不弹 toast,询问「路径“x”不存在。要从最近打开列表中删除它吗?」
  [删除] [取消](VSCode 同款),删除走 `forgetRecentRoot`
