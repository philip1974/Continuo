# install-from-git-localized

三个「从 Git 安装」入口(插件页 Git URL、市场卡片、市场 Git URL 段)共用 `installFromGitLocalized` 归一结果:

- 失败(ok:false 与 reject)按 code 本地化 message。
- 全新安装(非 overwrite)收到 `EEXIST` → `alreadyInstalled: true`:插件已在盘上但不在本窗口列表(别的窗口刚装、
  要重启才进列表;待重启记录不跨窗口)。三个入口据此提示「{name} 已安装 — 若尚未出现在插件列表中(如在其它窗口安装的),重启 Continuo 后加载」
  (插件已在本窗口加载时同样成立,不误导用户去重启)
  (非错误),而非「文件已存在」。覆盖安装与其它错误码不标。
- 尚不知插件名时(Git URL 入口)名称取 URL 的仓库名(`repoNameFromGitUrl`:末段去 `.git`)。
