# dock-reset-layout — 「视图:重置布局」

对齐 VSCode `workbench.action.resetViewLocations`(View: Reset View Locations):布局被拖乱(拆分、浮动、弹到子窗、最大化)
后,**有面板时**也能一步收回默认形态。此前只有面板全关后的空状态里才有「恢复默认布局」按钮(`src/shell/dock/EmptyState.tsx`)。

## 行为契约

1. **命令**:`workbench.action.resetViewLocations`,分类「视图」,标题三语(Reset Layout / 重置布局 / 레이아웃 초기화),
   无默认键,命令面板可搜可执行;作用于当前窗口的 dock(`runWhenDockLayoutReady`,布局恢复完成前排队)。
2. **重置**(`resetDockLayout`,`src/shell/dock/layout.default.ts`):
   - 有最大化的组 → 先退出最大化;
   - 拆分 / 浮动 / popout 子窗里的**全部面板收回主窗同一个组**(落点:编辑器所在的主窗组 > 第一个有面板的主窗组 > 新建主窗组),
     popout 子窗随之关闭(同把子窗里的 tab 拖回主窗:面板对象不重建,编辑器 / 终端按既有的 location 变化逻辑重绑文档);
   - 再按默认布局补上并激活编辑器(编辑器面板已关 → 重新打开,同空状态按钮)。
3. **安全**:不关闭任何面板 —— 编辑器组(含未保存的 tab,tab 在 editor store 里原样保留)、运行中的终端(会话不被杀)、
   设置 / 输出 / 插件面板都只换位置,因此不需要确认框。
4. **空状态按钮**「恢复默认布局」与命令同一实现(空状态时等价于只打开编辑器)。

## 规范

- `reset-layout.spec.ts`:真实 dockview(jsdom)+ 假 popout 子窗 —— 拆分 / 浮动收回一组且无面板被关、popout 收回且面板不重建、
  退出最大化、编辑器已关时重新打开、空状态只开编辑器、命令注册与三语标题。
- 真机 e2e `tests/e2e/dock-reset-layout.spec.ts`:编辑器弹到子窗后执行命令 → 子窗关闭、编辑器回到主窗。
