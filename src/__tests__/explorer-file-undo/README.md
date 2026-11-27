# explorer-file-undo(资源管理器文件操作撤销 / 重做)

## 背景

对齐 VSCode:资源管理器里的文件操作(改名 / 移动 / 新建 / 粘贴复制 / 从外部拖入)经 `IUndoRedoService`
的资源管理器来源(`explorerService.UNDO_REDO_SOURCE`)入栈,资源管理器树聚焦时 ⌘Z / ⇧⌘Z
(Win / Linux Ctrl+Z / Ctrl+Y、Ctrl+Shift+Z)撤销 / 重做;撤销「新建」= 删除新建项。
Continuo 用一个轻量撤销栈实现同一语义(`src/panels/Explorer/file-undo.ts`)。删除同 VSCode `bulkFileEdits.ts` 的
`DeleteOperation`:删除前读回每个文件的内容(单个文件上限 5MB,同 VSCode `fileActions.ts` 的 `MAX_UNDO_FILE_SIZE = 5000000`),
⌘Z 在原位置按读回的内容重建;文件夹只记「是文件夹」,撤销重建**空**文件夹(VSCode 同);废纸篓里那份不动(VSCode 同)。
移到废纸篓与永久删除都可撤销(VSCode 跳过废纸篓的删除同样带 `maxSize` 入栈)。
(第四十一轮审计曾把删除做成「屏障」:删除不可撤销且挡住更早的操作;第五十五轮审计 B 组 #3 改为照 VSCode 可撤销。)

## 行为契约

### 入栈

1. 每个工作区根一份栈(renderer 进程即窗口,故为「每窗口 × 每工作区」),上限 `FILE_UNDO_LIMIT = 50`,超出丢最旧。
2. 入栈的操作:
   - 改名、移动(拖动移动、剪切粘贴)→ `move`,记录实际成功的 `from → to`(部分成功只记成功项)。
   - 新建文件 / 文件夹、粘贴复制、从 Finder 等外部拖入写成的**新**文件 → `create`。
   - 外部拖入里选了「替换」同名文件 → **不入栈**(被替换的原文件无法恢复,撤销只会删掉新文件、造成误解);
     选「跳过」时写入的都是新文件,照常入栈。
3. 新操作入栈清空重做栈。删除(移到废纸篓 / 永久删除,至少删掉一项)入栈 `delete`,只含实际删掉的项:
   - 删除前(暂停自动保存之后)经 main `fs:read-for-undo` 读回每一项(lstat,不跟随符号链接):文件 ≤ 5MB → 内容;文件夹 →
     只标记;超过 5MB、符号链接等其它类型、读回失败 → 不重建(`skipped`)。一次删除读回总量超过 50MB(`MAX_UNDO_DELETE_TOTAL_BYTES`,
     撤销栈的内存兜底;VSCode 不限总量)的文件同样不重建。选中项嵌套时并入上级。
   - 撤销 `delete`:不确认(不是破坏性操作,VSCode `explorer.confirmUndo` 默认只对破坏性撤销确认);先校验全部要重建的原位置空闲、
     父目录存在(任一不满足 → 一项都不重建,失败同规则 4,位置被占提示「此位置已存在」),然后文件按原字节写回(`fs:write-binary`)、
     文件夹建空文件夹;定位到重建的第一项。没能重建的项与重建成空文件夹的项各提示一次(`panels.explorer.undo_delete_not_restored` /
     `panels.explorer.undo_delete_empty_folder`,三语:「…可从废纸篓找回」;VSCode 静默,这里明说)。
   - 重做 `delete`:撤销时重建的项须仍在;重新读回(按最新内容)再移到废纸篓(同删除流程的清理),作为新的 `delete` 回到撤销栈。
   - 删除不再挡住更早的操作:撤销删除之后,下一次 ⌘Z 撤销更早的操作。

### 撤销 / 重做

4. 执行前先校验**全部**目标处于预期状态,任一不满足 → 不动磁盘、返回失败(调用方提示),该操作出栈作废:
   - move:源(撤销时为 `to`)存在;目标位置(撤销时为 `from`)空闲(同目录只差大小写、同 inode 视为同一项,允许);
     目标父目录存在。
   - 撤销 create:新建项仍存在。
   - 重做 create:目标位置空闲、父目录存在;粘贴复制的源仍存在。
   - 目标位置被占(`FS_EEXIST`)→ 失败归到**本次撤销 / 重做的项**(撤销 move 为 `to`),占位路径记在 `existing`;
     提示写「无法撤销对「five.ts」的文件操作:此位置已存在「file-5.ts」」(`panels.explorer.file_undo_target_exists`)。
5. 撤销 create = 移到废纸篓(经调用方的删除流程,editor tab 等清理同删除)。**一律先确认**(新建 / 粘贴复制 / 外部拖入都是;
   对齐 VSCode `explorer.confirmUndo` 默认 "default":新建的撤销 `confirmBeforeUndo: true`、复制的撤销在 default 下确认),
   不因「看起来没改过」就静默删除;取消 → 什么都不做,操作留在撤销栈。确认框同删除确认:初始焦点在「移到废纸篓」
   (可恢复,回车即执行,`ConfirmDialog defaultAction='confirm'`)。
   确认框拿到其下未保存的编辑器数,> 0 时同删除确认给出未保存警告(「该文件有未保存的更改。删除后其编辑器保留并
   标记为「已删除」…」,单 / 复数句式同删除确认);框开着期间暂停这些文件的自动保存。
   一次输入嵌套路径新建(`a/b/c.ts`,见 `explorer-create-nested`)时记录的是本次新建的最上层项 + 余下的段(`redo.rest`):
   撤销删最上层新建项即覆盖整条链,已存在的中间目录不动;重做按「最上层名/rest」重新逐级创建。
6. 撤销 move 逆序执行;同目录走改名、跨目录走移动;每成功一项通知调用方「路径已移走」(editor tab / 展开集合 / 剪贴板跟随,
   复用改名 / 移动的清理);刷新涉及的目录。
7. 成功后操作进入另一栈(撤销 → 重做栈,重做 → 撤销栈);外部拖入的 create 无法重做(内容未保留)→ 撤销后清空重做栈。
8. 撤销 / 重做成功返回要定位的项:move → 恢复后的第一项;重做 create → 重建的第一项;撤销 create → 其父目录(根则不定位)。
9. 同一栈上撤销 / 重做执行中再触发 → 忽略(`busy`)。栈空 → `empty`,无提示。

### 键位与命令

10. 树内键位(`tree-keyboard.ts`,只在树聚焦时生效,编辑器 / 输入框里的 ⌘Z 不受影响):mod+Z 撤销;
    mac ⌘⇧Z、其它 Ctrl+Y / Ctrl+Shift+Z 重做。无焦点项时也生效。
11. 命令 `explorer.undo` / `explorer.redo`(「撤销文件操作」/「重做文件操作」,三语),无默认键;有工作区时打开侧栏并请求文件树执行。
12. 应用菜单「编辑 → 撤销 / 重做」:文件树聚焦时同样撤销 / 重做文件操作(VSCode undo 多实现命令,见 `app-menu-bar` 第 6 条)。

## 规范

- `file-undo.spec.ts`:栈与撤销 / 重做语义(规则 1-9)。
- `record-sources.spec.ts`:入栈来源(规则 2:粘贴复制回报、外部拖入「替换」不入栈)。
- `delete-undo.spec.tsx`:文件树里复制 → 删除 → ⌘Z 按删除前读回的内容原位重建(不确认),再 ⌘Z 才撤销复制(规则 3);撤销复制先确认、
  焦点在「移到废纸篓」(规则 5)。
- `read-for-undo.spec.ts`:main `fs:read-for-undo`(文件字节 / 文件夹 / 符号链接不跟随 / 不存在)。
- `tree-keys.spec.ts`:键位(规则 10)与命令(规则 11)。
- e2e:`tests/e2e/explorer-file-undo.spec.ts`(改名 / 移动 / 新建撤销重做、编辑器 tab 跟随、复制 → 删除 → ⌘Z 原位重建被删文件、再 ⌘Z 撤销复制)。
