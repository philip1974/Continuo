# editor-milkdown-writeback

行为契约:**Milkdown 防抖窗口内的输入不随关窗 / 卸载丢失**。

## 背景

`@milkdown/plugin-listener` 的 `markdownUpdated` 有 200ms 防抖(lodash debounce),编辑器销毁时不 flush。
关窗 flush 握手(DockShell `onFlushRequest`)只落盘 store 里的内容 → 最后 <200ms 的输入还没进 store:
原本干净的 tab 不弹确认直接丢;脏且为 autosave 持有者的 tab flush 写的是旧内容。

## 行为

- 活动 Milkdown 把「同步回写」句柄登记到 `editor-writeback-registry`;关窗握手在「保存」与 autosave flush
  **之前**调 `flushEditorWriteBacks()`,从编辑器同步取全文(`crepe.getMarkdown()`)回写 store。
- 只在有尚未上抛的编辑时回写(与防抖上抛同口径:只差尾部空白不算编辑,issue #44);只读预览不回写。
- Milkdown 卸载(切 tab / 切 mode / reloadEpoch 或 locale 重挂载)时同步回写一次,随后停用:迟到的防抖 emit
  不再上抛(否则会覆盖之后在 Source 里的新输入或外部重载)。
- `applyEditorWriteBack`:store 中该 tab 内容已不等于编辑器最近上抛的基线(外部改盘 reloadFromDisk 等)→ 不覆盖。
- 回写使原本干净的 tab 变脏时,React 尚未重渲、autosave 还没排队 → 关窗 autosave flush 发现 store 内容 ≠
  schedule effect 看过的内容即先补排队再 flush;autosave 失败后未再编辑则不重试。
- 上抛防抖自适应:不注册 `markdownUpdated`(其防抖里每次全量序列化),改用触发条件相同但不序列化的
  `updated`,自行按最近一次实测序列化耗时排期:总延迟 = max(200ms, 耗时 × 8),封顶 2s。小文档(<25ms)
  防抖到点即上抛,与原 200ms 节奏一致;延迟中的保存 / 关窗 / 卸载由同步回写补齐,之后到点按当前文档判定,
  不重复、不回退上抛旧内容;卸载清掉定时器。额外延迟到点时若文档相对排期时又变了(用户仍在打字、listener
  防抖未到),不在打字中途全量序列化,按额外延迟重排(不直接放弃:`addToHistory=false` 的事务不再触发
  `updated`);从本轮首次排期起最多等 5s 必上抛。
- 不做多余的全量序列化(大文档一次约 70ms):以「最近一次已处理的 ProseMirror 文档」为基线,文档不可变,
  引用相等即未变 → 回写直接返回;挂载时只记文档、不序列化,基线文本在首次需要比较时按**挂载时的文档**惰性
  序列化(单纯查看不被规范化改写);只读预览不记基线。

## 规范

| 文件 | 内容 |
|---|---|
| `milkdown-writeback.spec.tsx` | 回写句柄 / 卸载回写与停用 / 基线守卫 / 不做多余序列化 / 自适应上抛 / autosave flush 补排队 |
| `milkdown-ctx-contract.spec.tsx` | 真实 Crepe:slice 名取视图 / 序列化器、文档引用语义、卸载回写仍可取全文、真实 updated 约 200ms 上抛 |
| `../dirty-close-confirm/dockshell-save-on-close.spec.tsx` | 握手先回写再保存 / flush autosave |
