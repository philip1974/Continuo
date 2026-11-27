# editor-search-git-decorations(编辑器 tab 标题 / 搜索结果文件名按 git 状态着色)

对齐 VSCode:

- **编辑器 tab**(`multiEditorTabsControl.redrawTabLabel` → `ResourceLabel` 的 `fileDecorations`):tab 标题按 git 状态着色、
  标题后显示状态字母。设置 `workbench.editor.decorations.colors` / `workbench.editor.decorations.badges`,**默认都开**
  (VSCode `DEFAULT_EDITOR_PART_OPTIONS.decorations = { badges: true, colors: true }`,`workbench.contribution.ts` 同为 `true`)。
- **搜索结果文件行**(`searchResultsView` FileMatchRenderer `fileDecorations: search.decorations`):文件名着色 + 字母。
  设置 `search.decorations.colors` / `search.decorations.badges`,默认都开(`search.contribution.ts`)。
- 两处与资源管理器共用**同一份窗口级 git 状态**(同一根只有一个数据源、一份查询),不各自跑 git。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/hooks/useGitStatus.ts` | 窗口级共享数据源:按根一个 source(查询 / 刷新 / 单飞 / STALE 重试),各组件以 consumer 身份登记 |
| `src/panels/Explorer/git-decorations.ts` | `fileGitDecoration`:任意文件路径 → 装饰(根外 → 无) |
| `src/panels/Editor/EditorHeader.tsx` | tab 标题颜色、字母、悬浮提示 |
| `src/panels/Search/SearchPanel.tsx` | 结果文件行名称颜色、字母、悬浮提示 |
| `src/plugins/settings/core-setting-specs.ts` | 四项设置(编辑器设置页「标签页」组;资源管理器设置页「搜索」组) |
| `src/styles/theme.css` | `--md-git-*` 调整:tab 激活 / 悬停底、搜索选中 / 悬停底上两主题 ≥ 4.5 |

## 行为

### 共享数据源(`git-status-shared.spec.tsx`)

- 同一根的多个使用方(资源管理器、每个编辑器组的 tab 栏、搜索视图)只查询一次,刷新时也只查一次;结果同时到达各方
- 只要还有一个**可见**的使用方,fs 变化 / 保存 / 获焦就照常刷新(侧栏隐藏时 tab 仍更新);全部不可见才只记脏,
  任一方再次可见时补一次
- 最后一个使用方离开 → 停止监听、丢弃快照;之后再登记重新取
- 某使用方关掉装饰(enabled=false)只是它自己退出,不影响其他使用方

### 编辑器 tab(`editor-tab-git.spec.tsx`)

- 工作区内文件的 tab 标题 `text-git-<kind>`(激活 / 非激活 tab 都着色,VSCode 同);标题后显示字母(与标题同色,`aria-hidden`)
- 未跟踪目录下的文件 → 未跟踪色 + U;`.gitignore` 命中 → 置灰、无字母;工作区外 / 无状态 → 不装饰
- 悬浮提示:路径后追加「 · 已修改」等(VSCode `ResourceLabel` 把 decoration.tooltip 以 ` • ` 拼到 title);
  **可访问名称不变**(VSCode tab 的 aria-label 只用 `computeEditorAriaLabel`,不含 git 状态)
- 叠加:预览 tab 斜体 + 颜色;脏 tab 圆点 + 颜色;已删除(orphaned)删除线 + 颜色,「(已删除)」文字不着色
- `workbench.editor.decorations.colors=false` → 不着色(字母仍在);`badges=false` → 无字母(颜色仍在);两项都关 → 不查询
- 快照更新(文件被改 / 新建)后 tab 即时更新

### 搜索结果(`search-file-git.spec.tsx`)

- 结果文件行的文件名 `text-git-<kind>` + 字母(位于匹配数徽标左侧),悬浮提示追加状态;可访问名称不变
  (VSCode `fileMatchAriaLabel` 不含状态)
- `search.decorations.colors=false` / `badges=false` 各自关掉对应部分;都关 → 不查询;无结果时不查询

### 设置(`settings.spec.ts`)

- 四项默认值按 VSCode;注册到对应设置页,三语标题 / 描述齐全

### 对比度(`contrast.spec.ts`)

- 所有 `--md-git-*` 对 tab 栏底(canvas)、激活 tab 底(surface-container-high)、悬停 tab 底(state-hover 合成)、
  搜索行选中 / 悬停底(accent/15、accent/10 合成)在亮 / 暗主题下均 ≥ 4.5

## 与 VSCode 的差异

- 两项都关时不查询 git,悬浮提示也就不带状态(VSCode 仍追加 tooltip)
- tab 上同名区分路径(description)与搜索行的目录不着色(VSCode 整个 label 继承颜色、description 降透明度)
- 悬浮提示分隔符用 ` · `(与资源管理器一致),VSCode 用 ` • `
- 搜索设置放在资源管理器设置页「搜索」组(Continuo 无单独搜索设置页)

## e2e

`tests/e2e/editor-search-git-decorations.spec.ts`:改文件后 tab 着色、新文件 tab 未跟踪色、侧栏隐藏时 tab 仍更新、
搜索结果文件行着色 / 字母、关掉设置后消失、拖出到子窗(popout)的 tab 着色。
