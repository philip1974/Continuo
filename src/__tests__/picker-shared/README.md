# picker-shared(重构:CommandPalette / QuickOpen 共享的 picker 机制)

## 行为契约

命令面板与 Quick Open 是同一种交互:**焦点留在搜索框(combobox),上下键移动虚拟化 listbox 的
选中行,Enter 触发当前项**。此前两边的 store action、virtualizer 接线、越界钳制、滚动跟随、键盘导航、
ARIA 属性逐段复制,a11y(A15/A100/A101/A111/A112)与 race(R48/R49)修复每次都要两边同步。
收口到 `src/plugins/picker/`:`createPickerSlice`(store 切片)与 `usePickerList`(列表机制)。
DOM 输出与收口前逐属性一致。

### 规则(createPickerSlice)

1. `open` 置 `isOpen=true` 并重置 `query=''`、`selectedIndex=0`;`close` 只置 `isOpen=false`。
2. `setQuery` 截断超长 query(E279)并把 `selectedIndex` 归 0。
3. `moveSelection(delta, max)` 循环移动;`max<=0` 归 0。`clampSelection(len)` 钳到 `[0, len-1]`。
4. 任何 action 在无变化时保持 state 引用不变(不触发订阅者)。

### 规则(usePickerList)

5. combobox:`role=combobox`、`aria-expanded` 恒 true;仅 `count>0` 时 `aria-controls` 指向
   `${idPrefix}-listbox`;`aria-activedescendant` 仅当选中下标在范围内**且**在渲染窗口内时指向
   `${idPrefix}-option-${index}`。
6. 键盘:ArrowDown / ArrowUp → `moveSelection(±1, count)`;Enter → `onEnter(selectedIndex)`;三者都
   `preventDefault`,其余键不拦。IME 组合中(`isComposing` / `keyCode 229`)的按键一律不处理(不执行、不移动、不拦默认)。
7. `count` 变化 → `clampSelection(count)`;`selectedIndex` 变化且 `count>0` → `scrollToIndex`。
8. option:`id` / `role=option` / `aria-selected` / 绝对定位样式由 `getOptionProps(row)` 给出。

### 规则(usePickerToggleHotkey)

10. 两个 picker 互斥:按 ⌘P 打开 Quick Open 前关掉命令面板,按 ⌘⇧P 打开命令面板前关掉 Quick Open
    (占位文案「⌘⇧P 切到命令面板」);同一热键再按仍只 toggle 自身。

### 规则(pickerRowClassName,选中行可辨识)

11. 弹窗内容区背景是 `--md-surface-container-high`(= `bg-hover`),选中行不得用 `bg-hover`(计算值与背景
    完全相同,看不出选中)。两个 picker 共用 `src/plugins/picker/picker-row.ts`:选中 = `border-l-2 border-accent
    bg-accent/15`,未选中 = 同宽透明边 + 悬停 `bg-accent/10`。竖条色 `--md-primary` 对弹窗背景两主题 ≥ 3:1
    (WCAG 1.4.11)。对照 VSCode Quick Input:选中行是与弹窗底色明显不同的强调色(list.activeSelectionBackground)。
12. 行内次要文字(命令分类前缀 / 文件相对路径)走 `pickerRowSecondaryClassName(selected)`:常态 `text-fg-dim`;
    选中行与悬停行(行带 `group`,`group-hover:`)改 `text-fg-muted`。按 token 实值把 `--md-primary` 以行底透明度
    合成到 `--md-surface-container-high` 上,次要文字两主题 ≥ 4.5(选中 亮 6.25 / 暗 5.97,悬停 6.68 / 6.69;
    原 fg-dim 选中 4.05 / 3.20、暗色悬停 3.58 不达 AA)。对照 VSCode:选中行描述文字随
    `list.activeSelectionForeground` 提亮。
13. 行内命中字符(`<mark>`,`PICKER_MATCH_CLASS_NAME` = `bg-transparent font-semibold text-list-highlight`;VSCode
    `list.highlightForeground` + 加粗):Continuo 自有 `--md-list-highlight` 对弹窗底 / 选中行 / 悬停行(合成)两主题
    均 ≥ 4.5(亮色 `--md-primary` 在选中行上仅 4.31,故另设槽位)。

### 接线守卫

9. 两个 store 都用 `createPickerSlice`;两个组件都用 `usePickerList`,不再直接 `useVirtualizer`。
