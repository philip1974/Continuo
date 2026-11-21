// a11y(A27):Radix 右键菜单关闭后的焦点还原策略。
//
// Radix 默认在菜单关闭时把焦点还给触发元素(键盘用户应得的还原 —— Esc / 普通菜单项关闭
// 后焦点回到触发行/空白区)。但「新建文件/新建文件夹/重命名」会随后打开 CreateInput/
// RenameInput 并用 rAF 自聚焦,此时 Radix 的还原会把焦点抢回触发行,导致输入框失焦、Esc
// 落到错误元素被树容器 hotkeys 吞掉。
//
// 旧实现用「全局 onCloseAutoFocus 无条件 preventDefault」绕过 —— 副作用是所有其它关闭路径
// (Esc / cut / copy / paste / trash / 插件项)都丢失了 Radix 的焦点还原。
//
// 正确策略:默认保留 Radix 还原;仅在「会打开自聚焦输入框」的菜单项上一次性跳过还原。

export interface MenuFocusRestore {
  /** 在「会打开自聚焦输入框」的 onSelect 里调用,标记下一次关闭跳过焦点还原(一次性)。 */
  skipOnce(): void;
  /** 挂到 Radix Menu.Content 的 onCloseAutoFocus。 */
  onCloseAutoFocus(e: { preventDefault(): void }): void;
}

export function createMenuFocusRestore(): MenuFocusRestore {
  let skip = false;
  return {
    skipOnce() {
      skip = true;
    },
    onCloseAutoFocus(e) {
      if (skip) {
        skip = false; // 一次性:用过即清,后续关闭恢复默认还原
        e.preventDefault();
      }
      // 否则不 preventDefault → 保留 Radix 默认焦点还原(还给触发行)
    },
  };
}
