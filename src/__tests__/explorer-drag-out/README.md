# 从资源管理器拖到编辑器 / 终端(explorer-drag-out)

对齐 VSCode:把资源管理器树里的文件拖到编辑器组 → 在该组打开;拖到终端 → 插入路径。树内拖动移动文件、Finder 等 OS 文件
拖入树 / 终端 / 窗口、dock tab 拖动都不受影响。

## 参考:VSCode 的做法

- `explorerViewer.onDragStart` → `fillEditorsDragData`(`src/vs/workbench/browser/dnd.ts`):`text/plain` 写全部路径(换行分隔);
  `ResourceURLs` 只写**文件**(不含文件夹);另写 `CodeFiles`(全部路径,含文件夹)供跨窗口。
- `editorDropTarget.ts`:拖动经过编辑器组显示放置高亮;内容区边缘 10% 以内 → 按该方向拆分出新组,其余 → 放进该组。
  放下走 `ResourcesDropHandler.handleDrop`:`openEditors(..., { pinned: true })` 打开到目标组(拆分时是新组),然后聚焦该组。
  `editorGroupView.openEditors`:第一个编辑器激活,其余不激活、排在它后面。
- 文件夹:`ResourceURLs` 不含文件夹;`CodeFiles` 里的文件夹按 `allowWorkspaceOpen` 处理 —— 拖入单个文件夹 = 在新窗口打开该文件夹
  (`handleWorkspaceDrop`),不会作为编辑器打开。
- 终端(`terminalInstance.ts` `TerminalInstanceDragAndDropController.onDrop`):读 `ResourceURLs` / `CodeFiles` / OS 文件,取**第一个**路径,
  按 shell 转义后插入,不回车。

## 行为

1. **拖动数据**(dragstart,`@/lib/explorer-drag`):被拖的项 = 按下的行在选中集里 → 整个选中集,否则只有它(同树内拖动)。写入
   - `application/x-continuo-paths`:`[{ path, isDirectory }]` JSON(应用内接收端优先读它);
   - `text/uri-list`:每项的 `file://` URL(CRLF 分隔;空格 / `#` 等编码,Windows 盘符 `file:///C:/…`,UNC `file://server/share`);
   - `text/plain`:绝对路径,换行分隔。
   不写 `Files`:各处 OS 文件拖放(Finder)的判断不变,树拖出不会被当成 OS 文件(窗口不会把它当文件夹切换工作区)。
2. **拖到编辑器组**:dock 组当前显示的是编辑器组面板时,拖动经过 dock tab 栏、组内 tab 栏或内容区 → dockview 放置高亮(`--md-primary`
   语义色);放下 →
   - 中央 / dock tab 栏:在该组打开;内容区左 / 右 / 上 / 下边缘(dockview 的边缘区)→ 在那一侧拆出新编辑器组并在其中打开(popout / 浮动组
     不能分栏时作为同组另一面板,同 ⌘\);
   - 组内自己的 tab 栏(在 dock 面板内容顶部):tab 栏自己高亮整条(`bg-accent/20` + accent 内描边,同资源管理器放置行)并接收,放进该组,
     不当作内容区顶部边缘拆分(VSCode:拖到 tab 栏放进该组);经过它时 dockview 的内容区高亮撤掉;
   - 以**常驻**方式打开(已是该组预览 tab 的转常驻;已在别的组打开的也在目标组打开);多选按顺序全部打开,第一个成为活动编辑器并获焦;
   - 文件夹跳过(只拖文件夹 → 什么都不做);打不开的文件照常提示(同资源管理器单击打开)。
   组里显示的是终端 / 设置 / 插件面板时不接收;整个 dock 外缘不接收。dockview 自己的 tab / 组拖动、OS 文件拖放不走这里。
   编辑器组在 popout 子窗时同样可放(dockview 的放置监听随组进子窗)。
3. **拖到终端**:插入 shell 转义后的绝对路径(含文件夹),多个以空格分隔、末尾一个空格,不回车,终端获焦 —— 与 Finder 拖入同一套转义
   (按会话 shell family)、上限与提示(见 `terminal-drag-drop`);读自定义 MIME,不经 `getPathForFile`。popout 子窗里的终端同样(既有
   ownerDocument 捕获阶段监听)。
4. 树内拖动移动、Finder 拖入树 / 终端、dock tab 拖动行为不变。
5. **拖到编辑器内容区不改当前文档**(VSCode:拖到编辑器 = 打开;`editor.dropIntoEditor` 要按住 ⇧ 才插入):
   - 代码文件、Markdown 源码视图(CodeMirror)、Markdown 编辑视图(ProseMirror,含其中的代码块)都拦下按 `text/plain` 插入路径的默认行为,
     事件照常冒泡 → dockview 打开 / 按边缘拆分(行为 2);
   - **按住 ⇧ 放到文本上** → 插入,不打开、不拆分(dockview 不显示放置高亮):Markdown 插入相对文档目录的链接,图片为图片引用
     (源码:`[text](../src/a.ts) ![alt text](img/logo.png)`,同 VSCode `createUriListSnippet`;编辑视图:链接文字为文件名、图片 alt 为空);
     其它文件插入相对工作区根的路径(工作区外 → 绝对路径),多个以空格分隔(VSCode `RelativePathProvider` / `PathProvider`);文件夹不插入;
   - Finder 拖入编辑器的既有行为不变(Markdown 里的图片见 `markdown-image-paste`)。

## 与 VSCode 的差异

- 只拖文件夹到编辑器:VSCode 在新窗口打开该文件夹(拖入多个文件夹在临时工作区里是加入工作区);Continuo 什么都不做。
  文件与文件夹混拖:VSCode 因单个文件夹触发开窗而不打开文件;Continuo 只打开其中的文件。
- 拖到终端:VSCode 只插入第一个路径;Continuo 全部插入(与 Finder 多文件拖入终端一致)。
- 拆分的边缘区用 dockview 的落点判定(VSCode 编辑器拖放是 10% 边缘);没有 `workbench.editor.splitOnDragAndDrop` 设置 / 修饰键开关。
- 拖到整个 dock 外缘(没有组)不接收。

## 规范文件

- `drag-data.spec.ts`:拖动数据写入 / 读取 / 判定、file URL、树的 dragstart。
- `editor-drop.spec.ts`:编辑器组的接收判定、落点 → 拆分方向、放下后的打开(常驻、多选、第一个激活、文件夹跳过、拆分)。
- `tab-bar-drop.spec.tsx`:拖到组内 tab 栏的高亮与打开。
- `terminal-drop.spec.tsx`:拖到终端插入转义路径。
- `editor-content-drop.spec.tsx`:拖到编辑器内容区不插入(代码 / Markdown 源码 / 编辑视图)、⇧ 放下插入、dockview 遇 ⇧ 不接收。
- e2e:`tests/e2e/explorer-drag-out.spec.ts`(真实应用里树 → 编辑器打开、→ 编辑器边缘拆分、→ 终端插入;拖到 md / ts 内容区中央与边缘
  不改当前文档;⇧ 放下插入链接)。
