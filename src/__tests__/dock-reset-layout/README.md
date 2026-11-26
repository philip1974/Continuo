# dock-reset-layout — 「视图:重置布局」

对齐 VSCode `workbench.action.resetViewLocations`(View: Reset View Locations):布局被拖乱(拆分、浮动、弹到子窗、最大化)
后,**有面板时**也能一步收回默认形态。此前只有面板全关后的空状态里才有「恢复默认布局」按钮(`src/shell/dock/EmptyState.tsx`)。

## 行为契约

1. **命令**:`workbench.action.resetViewLocations`,分类「视图」,标题三语(Reset Layout / 重置布局 / 레이아웃 초기화),
   无默认键,命令面板可搜可执行;作用于当前窗口的 dock(`runWhenDockLayoutReady`,布局恢复完成前排队)。
2. **重置**(`resetDockLayout`,`src/shell/dock/layout.default.ts`):
   - 有最大化的组 → 先退出最大化;
   - 拆分 / 浮动 / popout 子窗里的**非编辑器面板收回主窗主编辑器组**(落点:主编辑器组(按组顺序的第一个)所在的
     主窗组 > 第一个有面板的主窗组 > 新建主窗组),popout 子窗随之关闭(同把子窗里的 tab 拖回主窗:面板对象不重建,编辑器 /
     终端按既有的 location 变化逻辑重绑文档);
   - **编辑器组不合并**(VSCode Reset View Locations 只动视图、不动编辑器组):第二个及以后的编辑器组各自成组,按组顺序依次
     分栏在前一个编辑器组右侧(组顺序 = 主窗里的空间顺序 —— 网格从左到右、从上到下,同 ⌘1/⌘2/⌘3 与 dock 标题「编辑器 N」,
     拖动换位后重置保持左右次序;popout 子窗里的组按 editor store 组顺序排在其后;`editor-groups/editor-groups-order.spec.tsx`) —— 原本叠在同一 dock 组里的、浮动的、在 popout 子窗里的都拆回为主窗分栏(⌘\ 拆两组后重置不再
     变成「编辑器 | 搜索 | 编辑器」);
   - 再按默认布局补上并激活编辑器(编辑器面板已关 → 重新打开,同空状态按钮);
   - **活动编辑器组不变**(VSCode 同):按重置前 editor store 的活动组激活(中途的移动会让 dockview 换活动组 —— 新建的分栏组
     成为活动组,store 随之跟过去),dock 与 store 一致;焦点在 dock 里(或已丢失:被拆出的编辑区随移动摘下)而不在该组 →
     微任务里聚焦它的编辑区;焦点在 dock 外(Explorer)不抢。
3. **安全**:不关闭任何面板 —— 编辑器组(含未保存的 tab,tab 在 editor store 里原样保留)、运行中的终端(会话不被杀)、
   设置 / 输出 / 插件面板都只换位置,因此不需要确认框。
4. **空状态按钮**「恢复默认布局」与命令同一实现(空状态时等价于只打开编辑器)。

## 规范

- `reset-layout.spec.ts`:真实 dockview(jsdom)+ 假 popout 子窗 —— 拆分 / 浮动收回一组且无面板被关、popout 收回且面板不重建、
  退出最大化、编辑器已关时重新打开、空状态只开编辑器、多个编辑器组保持左右分栏(拆分 / 叠在同组 / 在子窗)、叠放布局重置后
  活动组与焦点一致(焦点在单独成组的 / 被拆出的编辑器组、焦点在 dock 外)、命令注册与三语标题。
- 真机 e2e `tests/e2e/dock-reset-layout.spec.ts`:编辑器弹到子窗后执行命令 → 子窗关闭、编辑器回到主窗;
  `tests/e2e/dock-reset-layout-editor-groups.spec.ts`:叠放布局重置后活动组(标题)与键入的编辑器一致。
