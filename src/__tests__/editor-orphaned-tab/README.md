# editor-orphaned-tab

文件被删除而编辑器里有未保存修改时,对齐 VSCode 的 orphaned 编辑器:tab 保留、标为「已删除」,自动保存不再把文件写回;手动保存照常按路径重建。

## Contracts

- **标记**:tab 有仅运行时的 `orphaned` 标记(不进会话快照)。
  - Explorer 删除(`removePaths`):被删路径(目录含其下全部)的干净 tab 关闭(不变),脏 tab 保留并置 `orphaned`。
  - 外部删除:`fs:dir-changed` 命中脏 tab 时只做廉价 `fs:stat`(不读内容、不动编辑),确认不存在(隔 `EXTERNAL_DELETE_CONFIRM_MS` 复查仍不存在,先删后建式替换不算)→ 置 `orphaned`;文件重新出现 → 清除。同目录其它文件的变化(文件名集合不含本文件)不检查。
  - 清除:重命名 / 移动到新路径、保存成功(手动保存重建文件)、文件重新出现、还原 / 重新读到磁盘内容。
  - 标记变化 bump `chromeVersion`,tab 栏随之重渲。
- **tab 栏**:orphaned tab 的文件名加删除线,后缀「(已删除)」/ `(Deleted)` / `(삭제됨)`(VSCode:strikethrough + "(Deleted)")。
- **自动保存**:orphaned tab 不自动保存(已排队的取消;切走 / 关窗 flush 也跳过),删除后文件不会在自动保存延迟后「又出现」;该 tab 仍按未落盘的脏文件计入关窗确认。
  - 外部删除尚未被确认(防抖 + stat + 延迟复查约 0.8–1.5s)时自动保存先到点(含切走 / 关窗 flush):自动保存以 `recreateMissing: false` 保存,读盘确认文件不存在 → 不写回、就地置 `orphaned`,按未落盘处理,不弹「自动保存失败」提示。
- **手动保存**(⌘S / 关闭时选「保存」):照常写盘(VSCode 同样重新创建文件),成功后清除 orphaned。所在目录也已删除时保存失败(atomic-write 不建父目录),提示找不到文件。
- **Explorer 删除确认**:删除涉及有未保存修改的 tab → 确认框追加未保存警告(按数量用单 / 复数句式:只删这一个脏文件 →「该文件有未保存的更改…其编辑器」;多项 / 文件夹里只有 1 个脏 →「其中 1 个文件…其编辑器」;2 个及以上 →「其中 N 个文件…它们的编辑器」);此时即使关掉了「删除前确认」设置也照样确认(VSCode 的未保存警告不受 `explorer.confirmDelete` 控制)。无未保存 tab 时行为不变。
  - 确认框打开期间、以及确认后移到废纸篓在途期间,被删路径(含子路径)下 tab 的自动保存暂停(`autosave-hold.ts`,同关闭脏 tab 的确认框开着时暂停):确认框停留超过自动保存延迟再确认,脏 tab 仍保留并标记已删除,修改不写回磁盘 —— 与框内文案一致;取消则恢复,仍脏照常保存。
- 与 VSCode 的差异:VSCode 从 Explorer 删除时会先丢弃(soft revert)未保存修改并关闭编辑器;本项目保留编辑器与修改(只标记已删除),数据更安全,警告文案按此说明。

## Modules

| File | Role |
|---|---|
| `src/stores/editor.store.ts` | `EditorTab.orphaned`、`removePaths` 置位、`renamePath` / `markSaved` / `reloadFromDisk` 清除、`setOrphaned`、`countDirtyTabsUnder` |
| `src/panels/Editor/useExternalFileSync.ts` | 脏 tab 的存在性检查(stat + 延迟复查) |
| `src/panels/Editor/useAutoSave.ts` | orphaned 跳过自动保存;自动保存不重建已删除的文件;被 hold 的路径暂停 |
| `src/panels/Editor/autosave-hold.ts` | 按路径暂停自动保存(Explorer 删除确认 / 删除在途) |
| `src/panels/Editor/editor-file-actions.ts` | `saveFile` 的 `recreateMissing: false`:不存在则不写、置 orphaned |
| `src/panels/Editor/EditorHeader.tsx` | 删除线 +「(已删除)」 |
| `src/panels/Explorer/FolderTree.tsx` | 删除确认框的未保存警告;确认框打开 / 删除在途时 hold 被删路径的自动保存 |
| `orphaned-store.spec.ts` / `orphaned-panel.spec.tsx` / `orphaned-external-sync.spec.tsx` / `orphaned-trash-confirm.spec.tsx` | 上述契约 |
| `tests/e2e/editor-orphaned-tab.spec.ts` | 真实 Electron:编辑 .md 后删除 → tab 显示已删除、过了自动保存延迟文件也不被写回;删除紧贴自动保存到点前也不写回;确认框停留超过自动保存延迟再确认,tab 仍保留并标记已删除 |
