# 关闭编辑器 tab 回到组内最近使用的 tab

对齐 VSCode `workbench.editor.focusRecentEditorAfterClose`(默认 `true`):关闭**活动**编辑器 tab 后,激活该组里
**最近使用(MRU)**的那个 tab,而不是位置上相邻的 tab。

## 参考:VSCode 的做法

- `EditorGroupModel` 每组维护 `mru: EditorInput[]`:激活的编辑器移到首位;新打开但不激活的编辑器加入 MRU;
  关闭 / 移出组时从 MRU 删除。
- 关闭活动编辑器:`focusRecentEditorAfterClose` 为 true → 取 MRU 首个(除被关的);为 false 才按位置取相邻。
- 序列化(`ISerializedEditorGroupModel.mru`)随工作区状态持久化,重启后 MRU 仍是重启前的顺序。

## 行为

1. 每个编辑器组(含单组模式下唯一的组)各有一份 tab MRU:`activeTabId` 变为某 tab → 它移到该组 MRU 首位;组里新加入、
   从未激活过的 tab 不在 MRU 里(与 VSCode 把后台打开的编辑器放进 MRU 不同:那样关闭时会跳到从没看过的 tab;
   不在 MRU 里则回落到相邻规则,与此前一致);离开组(关闭 / 组被移除 / 文档被删除)的 tab 从 MRU 剔除。
2. 关闭**活动** tab → 该组 MRU 中下一个仍在组里的 tab 成为活动 tab;MRU 无可用项时按原规则(后一个,否则前一个)。
3. 关闭**非活动** tab → 活动 tab 不变。
4. 多组:各组 MRU 独立,在别的组激活同一文档不影响本组 MRU。
5. 持久化:会话快照为每组写 `mruPaths`(与 `openFilePaths` 同口径跳过插件打开的 tab);只有与默认顺序
   (活动文件在前,其余按打开顺序倒序 —— 即按顺序打开文件自然得到的 MRU)不同才写,旧形态不变。
   恢复时按 `mruPaths` 重建;旧数据(无该字段)按默认顺序。重启后关闭活动 tab 回到重启前最近使用的那个。
   启动对齐(编辑器组搬到别的 dock 面板)时 MRU 随组迁移。
6. 文档改名 / 移动(tab id 变)不保留其在 MRU 里的位置(活动 tab 仍在首位;非活动的改名 tab 移出 MRU,再次激活时重新加入)
   —— 取舍:改名非高频,不为此跟踪 id 映射。

## 可执行规范

- `editor-close-mru.spec.ts`
