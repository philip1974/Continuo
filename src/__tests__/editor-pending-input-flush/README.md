# editor-pending-input-flush

行为契约:**依据 tab 的 dirty / content / id 做决定的入口,先把编辑器里尚未上抛 store 的输入同步回写**。

## 背景

Milkdown 上抛 store 是防抖的,且按序列化耗时自适应延迟(大文档最长约 2s,见 `editor-milkdown-writeback`)。
这段窗口里 store 落后编辑器:tab 在 store 里可能还是干净的,或 content 还是旧的。凡是直接读 store 的
dirty / content、或会改 tab id 的入口,若不先 `flushEditorWriteBacks()`,这段输入就会被误判丢弃或覆盖。
`flushEditorWriteBacks` 同步、文档未变时 O(1);但文档有未上抛编辑时会整篇序列化(大文档约 70ms)并提前上抛,
所以**只回写受影响的 tab**:回写句柄按 tab id 登记(`registerEditorWriteBack(tabId, fn)`),
`flushEditorWriteBacks(tabIds)` 只回写这些 tab;省略参数 = 全部(仅关窗握手与切全局 mode 用)。

## 行为

- **关闭 tab**:点 × 时先回写再按最新 dirty 判定 —— 有未上抛输入 → 弹「放弃修改?」,不直接关闭丢弃。
- **切换 Edit / Source / Preview**:切换前先回写,新模式(Preview 只读视图 / Source)显示最新内容。
- **外部改盘重载**(`reloadFromDisk`):先回写,tab 因此变脏 → 保留用户输入,不被磁盘内容覆盖。
- **改名 / 移动**(`renamePath` / `setFilePath`,会换 tab id):先按旧 id 回写,输入随 tab 一起改名;
  否则卸载回写的闭包仍持旧 id,找不到 tab 而丢弃。
- **删除打开中的文件**(`removePath(s)`)与 **切工作区 root**(`closeTabsOutsideRoot`):先回写,tab 因此
  变脏 → 按既有规则保留,不随删除 / 切 root 静默关闭。
- **只回写受影响的 tab**:外部改了另一个打开中的干净文件(重载别的 tab)、改名 / 移动 / 删除不相关路径、
  切 root 不关闭正在编辑的 tab —— 都不回写正在编辑的 tab,其未上抛输入留在编辑器里按原节奏上抛
  (不在打字中途整篇序列化)。改名其父目录等会换该 tab id 的操作仍按旧 id 回写。
- Milkdown 自适应延迟上抛的定时器到点时,若此后编辑器文档又变了(用户仍在打字),不在打字中途做全量序列化,
  按额外延迟重新排期;但不能直接放弃(`addToHistory=false` 的事务不再触发 `updated`),且从首次未上抛的变化
  起最多等 5s 必上抛。

## 规范

| 文件 | 内容 |
|---|---|
| `pending-input-flush.spec.tsx` | 关闭 tab / 切 Preview / reloadFromDisk / 改名移动 / 删除 / 切 root 前回写;不相关 tab / 路径不回写 |
| `../editor-milkdown-writeback/milkdown-writeback.spec.tsx` | 打字中途到点重排 / 无 updated 仍最终上抛 / 5s 总等待上限 |
