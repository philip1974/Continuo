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
   `preventDefault`,其余键不拦。
7. `count` 变化 → `clampSelection(count)`;`selectedIndex` 变化且 `count>0` → `scrollToIndex`。
8. option:`id` / `role=option` / `aria-selected` / 绝对定位样式由 `getOptionProps(row)` 给出。

### 接线守卫

9. 两个 store 都用 `createPickerSlice`;两个组件都用 `usePickerList`,不再直接 `useVirtualizer`。
