# explorer-symlink-dir

行为契约:资源管理器中的**符号链接**(对齐 VSCode)。

## 行为

- 浅层列目录(`listDir` 默认 `maxDepth=1`,资源管理器逐层展开用):符号链接再 `stat` 目标
  - 目标是目录 → `isDirectory: true` + `isSymlink: true`:显示为**可展开文件夹**,排在目录组
  - 目标是文件 / 不存在(悬空)/ 循环自身(ELOOP)→ 按文件显示,仍带 `isSymlink: true`
- 链接行在名称后显示链接角标 `↪`(视觉 `aria-hidden`,读屏读视觉隐藏的「符号链接」),悬浮提示含「符号链接」
- 点击链接目录 → 展开(不当作文件打开、不再报「不是文件」)
- 展开链接目录:子项路径**以链接路径显示**(`<link>/child`,不 realpath 改写);指向祖先的循环链接
  (`up-loop → ..`)可逐层手动展开,每层一次 `listDir`,不会卡死
- 「全部展开」(及 Ctrl+Shift+= 展开选中)**跳过**符号链接目录 —— 循环链接不被批量无限展开
- 递归扫描(`maxDepth > 1`:Quick Open 等)**不跟随**链接:不递归进链接目录,链接项类型保持 `lstat` 口径
- 安全:渲染进程 `fs.listDir` 无工作区 scope 校验(VSCode 同:指向工作区外的链接照常显示、可展开);
  读取失败(权限等)走既有的目录读取失败行

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `list-dir-symlink.spec.ts` | 主进程 listDir 浅层按目标类型、悬空 / 自环、链接路径不改写、循环逐层、递归不跟随 |
| `tree-symlink-dir.spec.ts` | 树层:链接目录是文件夹可展开;expandAll 跳过链接目录 |
| `folder-tree-symlink-row.spec.tsx` | 行渲染:展开态 / 链接角标 / 悬浮提示;点击展开不打开文件 |
