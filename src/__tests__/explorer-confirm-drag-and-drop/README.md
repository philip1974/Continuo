# explorer-confirm-drag-and-drop(误操作防护:资源管理器拖动前确认 / 外部拖入同名确认)

## 行为契约

### 树内拖动移动(VSCode `explorer.confirmDragAndDrop`,默认开)

1. 设置 `explorer.confirmDragAndDrop`(默认 `true`)注册在设置页「资源管理器」分类,三语标题 / 说明。
2. 开着时,把文件 / 文件夹拖到某个文件夹行或空白处(root)**不立即移动**,先弹确认框:
   - 单项:「确定要将“x”移到“y”中吗?」;多项:「确定要将以下 N 个文件/文件夹移到“y”中吗?」并列出名字(最多 10 个,其余「另有 N 项」)。
   - 按钮「移动」(初始焦点,非破坏性)/「取消」;勾选框「不再询问」。
3. 确认 → 照原有漏斗(`runBatchTransfer` → `transferEntriesInto`)移动;勾了「不再询问」→ 同时把设置写成 `false`。
4. 取消 / Esc → 不移动。无论确认或取消,框关闭后焦点还给树(`tree.updateDomFocus`,被拖项仍是焦点 / 选中项)。
5. 设置关掉 → 拖动立即移动,无框。
6. 全部被拖项都已在目标目录(拖到原父目录,no-op)→ 不弹框、不移动。
7. 按住 ⌥(mac)/ Ctrl 拖放 = 复制,不确认(VSCode `confirmDragAndDrop = !isCopy && 设置`),见 `src/__tests__/explorer-drag-copy/`。

### 外部(Finder)拖入遇同名(VSCode `getMultipleFilesOverwriteConfirm`)

规则在 `explorer-batch-transfer/`(`dropForeignFilesInto`,纯逻辑);本主题验对话框接线:

8. 有同名文件 → 弹破坏性确认框:单项「目标文件夹中已存在名为“x”的文件。是否替换?」,多项列出名字;
   正文注明「此操作不可撤销!」;按钮「替换」(danger)/「跳过同名文件」(还有不冲突的项时才有)/「取消」(初始焦点)。
9. 选哪个就以对应的 `OverwriteChoice`(`replace` / `skip` / `cancel`)结束等待;Esc = 取消;关闭后焦点还给树。

## 规范

- `confirm-drag-and-drop.spec.tsx`:规则 1–6、8–9(jsdom,FolderTree + fake headless-tree)。
