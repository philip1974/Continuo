# editor-milkdown-writeback

行为契约:**Milkdown 防抖窗口内的输入不随关窗 / 卸载丢失**。

## 背景

`@milkdown/plugin-listener` 的 `markdownUpdated` 有 200ms 防抖(lodash debounce),编辑器销毁时不 flush。
关窗 flush 握手(DockShell `onFlushRequest`)只落盘 store 里的内容 → 最后 <200ms 的输入还没进 store:
原本干净的 tab 不弹确认直接丢;脏且为 autosave 持有者的 tab flush 写的是旧内容。

## 行为

- 活动 Milkdown 把「同步回写」句柄登记到 `editor-writeback-registry`;关窗握手在「保存」与 autosave flush
  **之前**调 `flushEditorWriteBacks()`,从编辑器同步取全文(`crepe.getMarkdown()`)回写 store。
- 只在有尚未上抛的编辑时回写(与 `markdownUpdated` 同口径:只差尾部空白不算编辑,issue #44);只读预览不回写。
- Milkdown 卸载(切 tab / 切 mode / reloadEpoch 或 locale 重挂载)时同步回写一次,随后停用:迟到的防抖 emit
  不再上抛(否则会覆盖之后在 Source 里的新输入或外部重载)。
- `applyEditorWriteBack`:store 中该 tab 内容已不等于编辑器最近上抛的基线(外部改盘 reloadFromDisk 等)→ 不覆盖。
- 回写使原本干净的 tab 变脏时,React 尚未重渲、autosave 还没排队 → 关窗 autosave flush 发现 store 内容 ≠
  schedule effect 看过的内容即先补排队再 flush;autosave 失败后未再编辑则不重试。
- 200ms 防抖本身不变。

## 规范

| 文件 | 内容 |
|---|---|
| `milkdown-writeback.spec.tsx` | 回写句柄 / 卸载回写与停用 / 基线守卫 / autosave flush 补排队 |
| `../dirty-close-confirm/dockshell-save-on-close.spec.tsx` | 握手先回写再保存 / flush autosave |
