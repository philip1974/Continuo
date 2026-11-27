# popout-stylesheets(popout 子窗跟随主窗后加载的样式)

行为契约:**面板弹出到 popout 子窗后,主窗 `<head>` 里后加入的样式表同样作用于每个已打开的子窗**。

## 背景

dockview 只在子窗打开时把主窗 `document.styleSheets` 抄一次(`dockview-core` `popoutWindow.js` → `addStyles`)。懒加载
chunk 的 CSS(生产:Vite 预加载插入的 `<link rel="stylesheet">`,如 Milkdown(Crepe)编辑模式、终端;dev:Vite 注入的
`<style>`)在此之后才进主窗 head,到不了子窗:子窗里首次切到 Markdown「编辑」时标题不加粗不放大,Crepe 浮动工具栏 /
链接浮层 / 斜杠菜单以普通文本平铺在文档下方。

VSCode 参考:`src/vs/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.ts` `applyCSS` —— 开窗时克隆主窗
head 的 `link[rel="stylesheet"], style`,之后用 MutationObserver 监听主窗 head(`childList`、`subtree`):新增的
`<style>` / `<link>` 克隆进子窗,原节点移除则移除克隆,`<style>` 文本变化写进克隆;跳过 title / script / meta。

## 行为(`src/shell/dock/popout-stylesheets.ts` `trackPopoutStylesheets()`,DockShell onReady 挂载)

- S1 子窗打开后主窗 head 新增 `<link rel="stylesheet">` → 每个子窗 head 出现同一绝对地址的 link。
- S2 新增 `<style>` → 子窗出现同文本的克隆;主窗改写其文本 → 克隆随之更新;主窗移除 → 克隆移除。
- S3 不重复:开窗时主窗已有的 `<style>` 已由 dockview 抄过,不再克隆;`<link>` 按绝对 href 去重(子窗已有同 href 的
  link 不再加;开窗时已在主窗 head 但子窗还没有的 link 补上)。非样式 link(如 `modulepreload`)与 `<title>` 变化不同步。
- S4 多个子窗各自同步;子窗关闭(组回主窗 / 移除)后不再写它;dispose 后停止。

## 刻意差异

- 开窗时已有的 `<style>` 由 dockview 按规则逐条抄成新 `<style>`,与原节点无对应关系:其后的文本变化(仅 dev HMR)
  不同步到已打开的子窗(重开子窗即可)。VSCode 自己负责初次克隆,故能同步。
- CodeMirror / ProseMirror 的 StyleModule 样式按视图所在 document 挂载(见 `editor-popout-root`),不经此处。
