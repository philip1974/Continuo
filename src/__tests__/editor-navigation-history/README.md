# 后退 / 前进(⌃- / ⌃⇧-)

对齐 VSCode `workbench.action.navigateBack` / `workbench.action.navigateForward`(HistoryService 的编辑器导航栈,
`workbench.editor.navigationScope` 默认范围)。此前没有后退 / 前进:⌘P 换文件、⌃G 跳远后回不到原处。

1. **命令**:id 同 VSCode,三语标题「返回 / 前进」。默认键 mac `ctrl+-` / `ctrl+shift+-`(⌃- / ⌃⇧-,Control 不是 ⌘);
   Windows / Linux `alt+left` / `alt+right`(VSCode Windows 默认值;VSCode Linux 默认是 Ctrl+Alt+- / Ctrl+Shift+-,Continuo
   的平台模型不区分 Windows 与 Linux,按 Windows 取)。经命令注册表接入快捷键页、命令面板键位与冲突判定。
   CodeMirror 在 Windows / Linux 上把 Alt+← / Alt+→ 当「按语法跳」(会吞掉按键)→ 去掉,⇧Alt+← / ⇧Alt+→ 按语法选择保留;
   mac 的 ⌃← / ⌃→ 不变。
2. **什么时候记一条**(VSCode 语义):
   - **换编辑器**:活动编辑器(活动编辑器组 + 该组的活动 tab)换成另一个 —— ⌘P、资源管理器、搜索结果、终端链接、⇧⌘T、
     ⌃Tab、tab 点击、点进另一个编辑器组、关掉当前 tab 后相邻 tab 接替 —— 都经 editor.store 的活动 tab 变化统一记录;
     会话恢复(requestFocus:false 的程序化打开)不记。⌃Tab 按住修饰键连按只记最后落到的编辑器(途经的不留记录;VSCode
     在选择器里浏览不打开编辑器)。
   - **同一文件里跳远**:活动编辑器的光标(取选区起止中较小的行)相对当前位置移动 **≥ 10 行**(VSCode
     TEXT_EDITOR_SELECTION_THRESHOLD)→ 新记一条:转到行(⌃G / Quick Open `:N` 的 Enter)、查找跳转、搜索结果点击、
     鼠标点远处都是这条路径。
   - **小幅移动 / 打字**:< 10 行 → 不新记,只把当前这条更新成最新光标(VSCode replace),所以后退回到的是离开前的光标。
   - 转到行的实时预览与 Esc 取消不记;Enter 记「原位置 → 目标」。
   - 记录时当前这条还没有光标(刚换过来的文件尚未移动过),且这次是用户动作(点击 / 方向键 / 打字,CodeMirror 事务带
     userEvent)→ 先按移动前的光标补上(用户在该视图里实际停留过的位置),再判断是否新记。
   - **打开到第 N 行**(搜索结果、终端链接、调试栈帧等 `editor.openFile({line})`;后退到未打开的文件):视图刚挂载即程序化
     定位(scrollToLine,事务无 userEvent)→ 不补记视图初始的第 1 行,目标直接替换只记文件的当前这条 —— 只记一条,后退一次
     即回到来处(VSCode 同;第四十轮审计:此前多停一个第 1 行)。⇧⌘T 重新打开按视图状态恢复光标(建视图时即带上,不产生
     选区变化),同样只记一条。转到行(Quick Open `:N`)的 Enter 显式记「原位置 → 目标」,不受影响。
3. **栈**:每条 = 编辑器组 + 文件路径 + 光标(行 / 列;Markdown 编辑 / 预览模式与图片只记文件)。上限 **50** 条,超出丢最旧;
   后退后再产生新导航 → 前进部分清掉。只在内存,不跨重启。
4. **窗口范围**:每个主窗一份(各主窗是独立的渲染进程);popout 子窗与其主窗共用一份(VSCode 辅助窗口与主窗共用一个
   HistoryService)。两条命令在 popout 子窗里也分发。
5. **执行后退 / 前进**:
   - 打开 / 激活该条的文件:原编辑器组还在 → 在原组;否则在触发窗口的编辑器组(`commandEditorGroupId`)。文件没开着 → 读盘打开;
     读不到 → 按 code 提示。
   - 有光标 → 移到该行列(越界不动)并居中(scrollToLine),编辑器获焦;只记文件的 → 只激活并聚焦。
   - 执行本身不产生新记录(VSCode navigating 标志)。栈到头 → no-op。
6. **文件被删除 / 移动**(`onEditorPathChange`):删除(含目录)→ 剔除其下条目,相邻重复合并,位置回到栈尾(VSCode remove);
   移动 / 改名(含目录)→ 条目路径同前缀改写,相邻重复合并。切换工作区根 → 不在新根下的条目剔除(同最近关闭栈)。
7. **终端里**:不让出,⌃- 照常交给 xterm,并截住冒泡、不交给全局分发(VSCode commandsToSkipShell 默认列表不含这两条命令,
   终端获焦时由 xterm 处理,不触发后退;第四十轮审计:此前 xterm 不发任何内容、事件冒泡到全局执行了后退,焦点离开终端)。
   带 ⌘ 的改绑键照常交给工作台(VSCode Meta 键跳过 shell)。见 `isTerminalKeptHotkey`。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/navigation-stack.ts` | 纯栈:记录 / 替换 / 上限 / 截断前进 / 删除 / 移动(EditorNavigationStack) |
| `src/panels/Editor/navigation-history.ts` | 每窗口一份:活动编辑器订阅、选区通知、后退 / 前进执行、路径变更 |
| `src/panels/Editor/codemirror-navigation-history.ts` | CodeMirror 选区变化 → 选区通知 |
| `src/panels/Editor/editor-commands.ts` | 命令 spec |
| `src/panels/Editor/codemirror-basic-setup.ts` | Win/Linux 去掉 Alt+← / Alt+→ 按语法跳 |
| `src/plugins/quick-open/use-goto-line.ts` | 预览 / 取消不记,Enter 记原位置 → 目标 |
| `src/panels/Editor/editor-recent-cycle.ts` | ⌃Tab 连按替换当前这条 |

## 规范

- `navigation-stack.spec.ts`:栈语义(阈值、替换、上限、截断、删除 / 移动合并)
- `navigation-history.spec.ts`:命令注册与键位、终端不让出、popout 分发、换编辑器 / 跳远 / ⌃Tab 记录、后退前进执行、
  路径变更、工作区切换、CodeMirror Alt+← 去冲突
- `navigation-goto-line.spec.tsx`:转到行的预览 / 取消不记,Enter 记原位置 → 目标
- `navigation-popout.spec.tsx`:原组已不在 → 触发窗口(主窗 / popout 子窗)的编辑器组
- `navigation-open-at-line.spec.ts`:打开到第 N 行(editor.openFile / 搜索结果)、⇧⌘T、后退到未打开的文件 —— 只记一条
