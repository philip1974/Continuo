# os-file-drop(从 Finder / 桌面拖入磁盘文件:打开,⇧ 才插入)

## 背景

修前:从 Finder 拖工作区外的 `notes.txt` 到代码编辑器 → CodeMirror 内建 drop 读出文件**内容**插到文档开头,当前文件变脏,
被拖文件也没打开;Markdown 源码视图同样;Markdown 编辑视图什么都不发生;拖 png 进代码编辑器什么都不发生;
拖到编辑区以外的地方只处理文件夹,普通文件静默忽略。

## 行为(对齐 VSCode)

VSCode:外部拖入的文件一律在编辑器里打开(`ResourcesDropHandler` → `openEditors`,pinned;图片打开图片预览);
拖入文件夹打开为工作区;`editor.dropIntoEditor.enabled`(缺省开):**按住 ⇧** 放到文本编辑器里才插入
(Markdown:`markdown.editor.drop.enabled` 插入链接 / 图片引用;其它文件:路径)。

| 落点 | 不按 ⇧ | 按住 ⇧ |
|---|---|---|
| 代码编辑器(CodeMirror) | 打开全部文件(当前文档不变;图片 → 图片预览) | 插入路径:工作区内 → 相对工作区根,其余 → 绝对路径,空格分隔;不打开 |
| Markdown 源码视图 | 图片:存到文档旁并插入 `![alt text](…)`(见 `markdown-image-paste`,fb5a41fd 已定:Finder 拖图片无需 ⇧);其它文件打开 | 图片同左;其它文件插入相对文档的链接 `[text](…)`;不打开 |
| Markdown 编辑视图(Milkdown) | 图片:同上(Crepe 上传器存图插入);其它文件打开 | 图片同左;其它文件插入链接节点(文件名带链接);不打开 |
| 只读编辑器 / Markdown 预览 / 图片预览 / 空编辑器组 | 打开全部文件 | 同左 |
| 编辑区以外(标题栏、侧栏、状态栏、终端面板以外的 dock 区域等) | 打开全部文件(在活动编辑器组) | 同左 |
| 任意位置拖入文件夹 | 打开为工作区(`window-drop`,不变) | 同左 |

- 多个文件全部打开,第一个成为该组活动编辑器并获焦(与资源管理器拖入同一个 `openDroppedFiles`)。
- 落在编辑器组里 → 在**该组**打开;编辑区以外 → 活动编辑器组。
- 工作区外的文件按现有模型打开(编辑器读文件不限工作区,同资源管理器 / 最近打开)。
- 资源管理器内部拖动(`explorer-drag-out`)、终端拖入(`terminal-drag-drop`)、资源管理器文件树接收拖入(复制进目录)不变。
- 一次拖放谁处理:编辑器内容先收到事件,插入了哪些文件就「认领」哪些(`claimDroppedFiles`);编辑器面板(`data-editor-group-id`
  根元素上的 `onDrop`,popout 子窗同样生效)打开剩下的并认领;窗口级监听只打开仍未认领的。不靠 `defaultPrevented`
  判断(dockview 根 Droptarget 的 drop 无条件 `preventDefault`,见 `window-drop/README.md`)。

## Modules

| File | Role |
|---|---|
| `src/lib/window-drop.ts` | `claimDroppedFiles` / `unclaimedDroppedFiles`(按事件记录已处理的文件)、`captureDroppedRegularFiles`(同步取出非目录文件) |
| `src/panels/Editor/editor-media-drop.ts` | `isOsFileDrop`(有 Files、不是资源管理器拖动)、`diskPathsOf`(`webUtils.getPathForFile`,preload `coApi.window.getPathForFile`) |
| `src/panels/Editor/os-file-drop.ts` | `takeUnclaimedDroppedPaths`(同步取未认领文件的路径并认领)、`openOsDroppedFiles(event, groupId)` |
| `src/panels/Editor/codemirror-media-drop.ts` | CodeMirror:磁盘文件一律拦下内建「读内容插入」;⇧ 插入路径 / 链接,Markdown 图片存图插入 |
| `src/panels/Editor/milkdown-media-drop.ts` | Milkdown:非图片文件拦下;⇧ 插入链接;图片交给 Crepe 上传器 |
| `src/panels/Editor/EditorPanel.tsx` | 根元素 `data-editor-group-id` + `onDragOver` / `onDrop` → `openOsDroppedFiles(…, groupId)` |
| `src/shell/App.tsx` | 窗口级 drop:有文件夹 → 打开为工作区(不变);否则在活动编辑器组打开未认领的文件(文件 / 文件夹无法同步判定时先按目录探测) |
| `editor-os-drop.spec.tsx` | CodeMirror(代码 / Markdown 源码)、Milkdown 编辑视图、只读、文件夹 |
| `window-os-drop.spec.ts` | 打开未认领文件、认领跳过、文件夹不当文件打开 |
| `tests/e2e/os-file-drop.spec.ts` | 真实 Electron:txt / png / 多文件拖进代码编辑器、md 源码 / 编辑视图、编辑区外 → 打开且当前文档不变;⇧ 插入 |
