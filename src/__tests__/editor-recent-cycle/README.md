# ⌃Tab / ⌃⇧Tab:按组内最近使用顺序切换编辑器

对齐 VSCode `workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup`(⌃Tab)/
`workbench.action.quickOpenLeastRecentlyUsedEditorInGroup`(⌃⇧Tab)的**极简版**:不弹选择器,直接切过去。此前 ⌃Tab 无反应,
上一个 / 下一个编辑器只有按位置的 ⌥⌘← / ⌥⌘→。

1. **命令**:两条命令 id 同 VSCode,三语标题;默认键 `ctrl+tab` / `ctrl+shift+tab`,mac / Windows / Linux 相同(mac 也是 Control)。
   经命令注册表接入快捷键页、命令面板键位显示与冲突判定。
2. **一次导航**:按住修饰键期间连按 ⌃Tab,沿**开始时**组内 MRU 快照依次往后(上一个最近使用 → 再上一个 …,首尾相接),
   **不会**在两个 tab 间来回跳;⌃⇧Tab 往回走,首按直接落到最久未用的 tab。
3. **结束导航**:keyup 时 ⌃ / ⌘ / ⌥ 都已松开、或窗口失焦 → 本次导航结束;下次 ⌃Tab 从新的 MRU 开始(松开后再按一次 =
   回到上一个编辑器,VSCode 同)。期间别处换了活动 tab(点 tab、打开文件)或组内 tab 增删 → 下次按重新开始。
4. **MRU**:导航只把最终落到的 tab 提到组 MRU 最前,途经的 tab 保持原相对顺序(VSCode:在选择器里浏览不改变 MRU)。
   后退 / 前进的导航栈同样只记最后落到的编辑器(BDD: src/__tests__/editor-navigation-history/)。
5. **作用范围**:触发它的窗口的编辑器组(`commandEditorGroupId`;popout 子窗里按作用于子窗的组,两条命令在子窗分发);
   组内 tab < 2 → no-op。编辑器组不是该窗口 dock 的活动面板(焦点在同组终端里)→ 先激活编辑器组面板;切过去的编辑器获焦
   (VSCode:选中后焦点进编辑器,终端里按也一样)。
6. **终端里**:⌃Tab / ⌃⇧Tab 让出(不进 shell),同样切编辑器(VSCode 终端里同)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-recent-cycle.ts` | 命令常量、导航会话、MRU 改写 |
| `src/panels/Editor/editor-commands.ts` | 命令 spec |
| `src/panels/Terminal/terminal-hotkeys.ts` | 终端让出(`WORKBENCH_RECENT_EDITOR_COMMANDS`) |
| `src/plugins/command-palette/useCommandHotkeys.ts` | popout 子窗分发白名单 |

## 规范

- `editor-recent-cycle.spec.ts`
