# explorer-drag-copy(资源管理器树内 ⌥ 拖放复制)

行为契约:**在资源管理器里按住 ⌥(macOS)/ Ctrl(Windows / Linux)拖放文件或文件夹 = 复制**,不按 = 移动(原有行为)。

## VSCode 参照(`explorerViewer.ts` FileDragAndDrop)

- `isCopy = (ctrlKey && !isMacintosh) || (altKey && isMacintosh)`,经过时与松手时各判一次。
- 经过:`effectType = isCopy ? Copy : Move`(光标显示复制 / 移动)。复制时可以拖到源的原父目录(移动时那是 no-op、不接受);
  拖到自身 / 自身子树仍不接受。空白处:移动时「全在根下」不接受,复制时接受。
- 松手:`confirmDragAndDrop = !isCopy && explorer.confirmDragAndDrop` —— **复制不弹确认**;`doHandleExplorerDropOnCopy` 对每项
  `findValidPasteFileTarget`(同名按 `explorer.incrementalNaming` 自动改名,默认 simple:「a copy.txt」「a copy 2.txt」),
  完成后 `openEditors(复制出的文件, pinned)`(文件夹不打开)。

## 行为

1. 拖动经过树(行或空白处)时,按住 ⌥ / Ctrl → 光标为复制(`dropEffect = 'copy'`),否则移动(`'move'`)。松手前切换按键即时生效。
2. 按住 ⌥ / Ctrl 松手 → 复制到目标目录(拖到文件 = 其所在目录;拖到空白处 = 根):
   - 不弹「移动确认」(无论 `explorer.confirmDragAndDrop`);源不动;
   - 目标有同名 → 自动改名(「a copy.txt」),不覆盖;拖到原父目录 / 根下已有的项拖到空白处 → 生成副本;
   - 复制出的**文件**以常驻方式在活动编辑器组打开(第一个成为活动编辑器并获焦),复制出的文件夹不打开;
   - 与粘贴同一漏斗(`runBatchTransfer('copy')`):部分失败提示「复制失败:…」(三语 `errors.folder.copy_failed`)、
     成功项进 ⌘Z 撤销栈(撤销 = 移到废纸篓)。
3. 平台:macOS 只认 ⌥(Ctrl 拖放仍是移动);Windows / Linux 只认 Ctrl。

## 实现

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/batch-transfer.ts` | `isCopyDragEvent(e, platform)` |
| `src/panels/Explorer/FolderTree.tsx` | 容器捕获阶段 `handleDropCapture` 记下松手时是否复制(早于行 / 容器的 drop 回调);`onDropItems` / 空白处 drop 按它走 `copyDraggedItems` 或原移动流程;`handleDragOverCapture` / `handleDragOver` 写 `dropEffect`;`runBatchTransfer` 返回成功的「源 → 目标」供打开复制出的文件 |

## 规范

- `drag-copy.spec.tsx`:平台判定;⌥ 拖到文件夹复制不确认、源不动、打开复制出的文件;拖到原父目录生成副本;同名改名;文件夹不打开;
  不按键仍确认移动;其它平台 Ctrl / mac Ctrl 不算;⌥ 拖到空白处复制;拖动经过的 dropEffect
- e2e `tests/e2e/explorer-drag-copy.spec.ts`:真实鼠标按住 ⌥ 拖到文件夹 → 复制(源仍在、无确认框、复制出的文件在编辑器打开);拖到原父目录生成「copy」副本
