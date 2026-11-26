# 预览编辑器(preview editor)

对齐 VSCode `workbench.editor.enablePreview`(默认开):从资源管理器 / 搜索结果单击打开的文件以**预览**方式打开 ——
tab 标题斜体;以预览方式再打开别的文件时**原位替换**它,不新增 tab。编辑、保存、双击等操作后转为**常驻**(pinned)。

## 参考:VSCode 的做法

- `EditorGroupModel` 每组至多一个 `preview` 编辑器;`openEditor` 以非 pinned 打开新编辑器而组里已有预览编辑器 →
  `replaceEditor`:关掉旧预览(`EditorCloseContext.REPLACE`,不进「重新打开已关闭的编辑器」列表),新编辑器占它的位置。
  已打开的编辑器以 `pinned: true` 再打开 → `pin`;以非 pinned 再打开不会取消常驻。
- `editorGroupView.doOpenEditor`:`pinned = sticky || !enablePreview || editor.isDirty() || options.pinned ?? (有 index)`。
- 预览编辑器变脏 → `onDidChangeEditorDirty` 里 `pinEditor`(「Always show dirty editors pinned」)。
- `multiEditorTabsControl`:非 pinned 的 tab 标题 `italic`;双击预览 tab → `pinEditor`(双击常驻 tab 是切换组大小,Continuo 无此功能)。
- 跨组移动 / 复制(拆分)的编辑器一律 `pinned: true`;组内移动到别的位置也会 pin。
- `workbench.action.keepEditor`(默认键 ⌘K Enter)把活动编辑器转常驻;关闭 `enablePreview` 时现有预览编辑器全部 pin。
- 资源管理器 / 搜索结果:列表单击 → 非 pinned(预览);双击 / Enter → pinned。`enablePreviewFromQuickOpen`、
  `enablePreviewFromCodeNavigation` 默认 `false`:⌘P、跳转定义打开的是常驻编辑器。
- 「重新打开已关闭的编辑器」以 `pinned: true` 打开;后退 / 前进不指定 pinned(按上面的默认规则)。
- 读屏:VSCode 的 `computeEditorAriaLabel` 给预览编辑器加「{0}, preview」后缀;Continuo **不加**(见「与 VSCode 的差异」)。

## 行为

1. 设置 `workbench.editor.enablePreview`(编辑器设置页「标签页」组,默认开,三语文案)。
2. **以预览方式打开**:资源管理器单击文件(双击、Enter 不算)、搜索结果的匹配行单击。设置开时,目标编辑器组:
   - 组里没有预览 tab → 新 tab 成为预览 tab(追加在末尾,同常驻打开);
   - 组里有别的预览 tab → 新 tab 占它的位置,被替换的文档不在别的组就关闭(干净,不确认,不进 ⇧⌘T 栈);
   - 文件已在组里打开 → 只切换,常驻 / 预览状态不变。
   每个编辑器组至多一个预览 tab。读盘期间用户已切到别的 tab(打开只在后台加入)时,不替换正在显示的预览 tab(新 tab 常驻)。
3. **常驻打开**:资源管理器双击 / Enter、新建文件、⌘P(含 `文件:行`)、搜索结果双击 / Enter / F4 —— 新 tab 常驻;文件已是预览 tab → 转常驻。
   其它打开方式(后退 / 前进、⇧⌘T、链接、终端链接、插件 `editor.openFile`、会话恢复):新 tab 常驻,已开着的不变。
4. **转为常驻**:内容变脏(编辑)、保存(各组)、双击预览 tab、「保留编辑器」命令(`workbench.action.keepEditor`,三语标题,
   无默认键,只进命令面板;作用于触发窗口的编辑器组的活动 tab)、资源管理器双击 / Enter、⌘P 打开该文件。
   在预览 tab 里滚动、移动光标不算(VSCode 同)。脏 tab 一定常驻,所以替换不会丢改动(替换前先回写编辑器里未上抛的输入)。
5. **显示**:预览 tab 的标题斜体(`italic`,颜色 token 不变);tab 的可访问名称不变。
6. Markdown(编辑 / 源码 / 预览模式)、图片预览 tab 同样适用。
7. **编辑器组**:预览状态按组记录。拆分(⌘\ / tab 右键拆分)出来的副本在新组里常驻(VSCode 复制编辑器 pinned),源组不变;
   关闭组时移到相邻组的 tab 常驻;文档改名 / 移动后常驻(不跟踪 id 映射,同 MRU 的取舍)。
8. **导航历史**:被替换掉的预览文件的后退 / 前进条目保留(VSCode 同:历史按资源记录),后退到它时按常驻重新打开并定位;
   视图状态(光标 / 滚动)与关闭 tab 一样丢弃(由导航条目里的光标定位)。
9. **持久化**:会话快照记预览 tab —— 单组 `editor.previewPath`,多组各组 `previewPath`(插件打开的 tab 不记),窗口段与
   按文件夹快照同一 schema;重启 / 切回文件夹后预览 tab 仍是预览。旧数据无该字段 → 全部常驻。
10. **设置关闭**:之后所有打开方式都常驻(与此前行为一致);已有的预览 tab 立即全部转常驻。

## 与 VSCode 的差异

- 读屏名称不加「, 预览」后缀(VSCode 加):保持 tab 名称稳定;预览状态只有视觉区分。
- 后退 / 前进重新打开未开着的文件时常驻(VSCode 不指定 pinned,按默认规则是预览)。
- 编辑器 tab 不支持拖动排序 / 拖到别的组,「拖动 tab 转常驻」无对应入口;跨组移动只有关闭组时的移入,按常驻处理。
- 搜索结果 F4 / ⇧F4 按常驻打开。

## 可执行规范

- `editor-preview-store.spec.ts`:store 语义(替换 / 转常驻 / 组 / 规范化)
- `editor-preview-open.spec.ts`:openFileByPath 的打开方式(预览 / 常驻 / 缺省、双击竞态)、设置开关、保留编辑器命令、保存即常驻
- `editor-preview-entry-points.spec.tsx`:资源管理器单击 / 双击 / Enter、搜索结果单击与其它方式的打开选项
- `editor-preview-navigation.spec.ts`:被替换的预览文件后退 / 前进、⇧⌘T 重新打开常驻
- `editor-preview-header.spec.tsx`:斜体标题、双击 tab 转常驻、可访问名称不变
- `editor-preview-persist.spec.ts`:会话快照写出 / 恢复、旧数据
