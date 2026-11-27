// tab 右键菜单(VSCode 编辑器标签右键:关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭,文件 tab 另有复制路径等)。
// 编辑器文件 tab(EditorHeader)与 dock 面板 tab(SharedTab)共用外壳:Radix ContextMenu + design MenuItem(同 Explorer /
// 终端右键菜单)。菜单项在打开时才构建;菜单画在 tab 所在文档(popout 子窗的 tab 菜单画在子窗)。
// 键盘:tab 聚焦时 Shift+F10 / 菜单键在 tab 左下角打开。BDD: src/__tests__/tab-context-menu/
// 列表行(搜索结果 / 设置项 / 快捷键)的右键菜单复用同一外壳,keyboardAnchor 指定键盘打开时的定位元素。
// BDD: src/__tests__/list-context-menus/

import * as Menu from '@radix-ui/react-context-menu';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { MenuItem } from '@/design';
import { focusWithinOrLost } from '@/design/focus-within-or-lost';
import { dispatchContextMenuAt, isContextMenuKey } from './context-menu-key';
import { CONTEXT_MENU_CONTENT_CLASS_NAME } from './menu-surface';

export type TabMenuEntry =
  | {
      readonly label: string;
      readonly onSelect: () => void;
      readonly disabled?: boolean;
      /** 右侧键位提示(如关闭的「⌘W」,design MenuItem shortcut 槽)。 */
      readonly shortcut?: string;
      /**
       * 该项随后打开自聚焦的输入框(如终端「重命名…」):关闭菜单时不把焦点还给 tab(同 Explorer menu-close-focus 的
       * skipOnce),否则 Radix 的还原会抢走输入框焦点。其它关闭路径照常还原。
       */
      readonly opensFocusedInput?: boolean;
      /**
       * 该项可能打开模态确认框(如关闭类项遇未保存文件 / 运行中的终端):等菜单关闭、焦点回到触发 tab 后再执行。
       * 否则 Radix 在菜单卸载后(setTimeout)才把焦点还给 tab,会抢走刚打开的确认框的初始焦点;先还原再执行,
       * 不弹框时动作看到的焦点也在 tab 上(与 ⌘W / 点 × 同:关掉活动 tab 后焦点进新的活动编辑器 / 面板)。
       */
      readonly opensDialog?: boolean;
    }
  | 'separator';

/**
 * 聚焦的 tab 上按 Shift+F10 / 菜单键 → 在该元素(或 keyboardAnchor 给出的元素)处派发 contextmenu(冒泡到 Trigger 打开菜单)。
 */
function openFromKeyboard(
  event: KeyboardEvent<HTMLElement>,
  keyboardAnchor: ((target: HTMLElement) => HTMLElement | null) | undefined,
): void {
  if (!isContextMenuKey(event.nativeEvent)) return;
  // 阻止 Windows 再按默认行为派发一次 contextmenu。
  event.preventDefault();
  event.stopPropagation();
  const target = event.target as HTMLElement;
  dispatchContextMenuAt(keyboardAnchor?.(target) ?? target);
}

export function TabContextMenu({
  entries,
  keyboardAnchor,
  children,
}: {
  /** 打开时调用一次,构建菜单项。 */
  readonly entries: () => readonly TabMenuEntry[];
  /**
   * 键盘(Shift+F10 / 菜单键)打开时菜单定位的元素(须在触发区内,contextmenu 由它冒泡到 Trigger);缺省 / 返回 null = 焦点元素。
   * 如搜索结果树焦点在树容器上(aria-activedescendant)→ 定位到活动行;设置项 → 行上的「更多操作」按钮(VSCode 同)。
   */
  readonly keyboardAnchor?: (target: HTMLElement) => HTMLElement | null;
  /** 触发区(单个元素,Radix asChild 合并 contextmenu / keydown 处理)。 */
  readonly children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | undefined>(undefined);
  const skipFocusRestoreRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger
        asChild
        onContextMenu={(e) => {
          // 记下打开前的焦点(右键按下 / Shift+F10 时在 tab 上),按触发区所在文档取 —— popout 子窗里全局 document 是主窗。
          // 不直接用 currentTarget:编辑器 tab 的触发区是 display:contents 包裹层,不可聚焦。
          // 不用 instanceof HTMLElement:子窗元素属子窗 realm。
          const active = e.currentTarget.ownerDocument.activeElement as HTMLElement | null;
          restoreFocusRef.current = active !== null && typeof active.focus === 'function' ? active : null;
          setPortalHost(e.currentTarget.ownerDocument.body);
        }}
        onKeyDown={(e) => openFromKeyboard(e, keyboardAnchor)}
      >
        {children}
      </Menu.Trigger>
      {open && (
        <Menu.Portal container={portalHost}>
          <Menu.Content
            className={CONTEXT_MENU_CONTENT_CLASS_NAME}
            collisionPadding={8}
            onCloseAutoFocus={(e) => {
              // 焦点还原自己做:Radix FocusScope 按全局 document(主窗)记录 / 还原打开前焦点,popout 子窗里的 tab
              // 菜单关闭后焦点会落到子窗 body。改为还原到触发区所在文档里打开前的焦点。
              // 只在焦点已丢失(随菜单卸载落到 body / 脱离文档)时还原:动作自己移动了焦点(如「向右拆分」聚焦新组的
              // 编辑器)、点菜单外部时焦点进了被点的元素,都以那里为准(VSCode 同);点外部而焦点没去处(popout 子窗里
              // 点到的元素被菜单的 pointer-events:none 挡住、拿不到焦点)→ 回到打开前的焦点,不丢输入。
              e.preventDefault();
              const skip = skipFocusRestoreRef.current;
              skipFocusRestoreRef.current = false;
              const prev = restoreFocusRef.current;
              restoreFocusRef.current = null;
              if (!skip && prev?.isConnected && focusWithinOrLost(prev.ownerDocument, null)) prev.focus({ preventScroll: true });
              // opensDialog 项:焦点回到 tab 后(同一任务内的微任务)再执行。
              const pending = pendingActionRef.current;
              if (pending) {
                pendingActionRef.current = null;
                queueMicrotask(pending);
              }
            }}
          >
            {entries().map((entry, i) =>
              entry === 'separator' ? (
                <Menu.Separator key={`sep-${i}`} className="my-1 h-px bg-line" />
              ) : (
                <Menu.Item
                  key={entry.label}
                  asChild
                  onSelect={() => {
                    if (entry.opensDialog) {
                      pendingActionRef.current = entry.onSelect;
                      return;
                    }
                    if (entry.opensFocusedInput) skipFocusRestoreRef.current = true;
                    entry.onSelect();
                  }}
                  disabled={entry.disabled}
                >
                  <MenuItem disabled={entry.disabled} shortcut={entry.shortcut}>
                    {entry.label}
                  </MenuItem>
                </Menu.Item>
              ),
            )}
          </Menu.Content>
        </Menu.Portal>
      )}
    </Menu.Root>
  );
}
