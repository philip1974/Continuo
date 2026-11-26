// tab 右键菜单(VSCode 编辑器标签右键:关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭,文件 tab 另有复制路径等)。
// 编辑器文件 tab(EditorHeader)与 dock 面板 tab(SharedTab)共用外壳:Radix ContextMenu + design MenuItem(同 Explorer /
// 终端右键菜单)。菜单项在打开时才构建;菜单画在 tab 所在文档(popout 子窗的 tab 菜单画在子窗)。
// 键盘:tab 聚焦时 Shift+F10 / 菜单键在 tab 左下角打开。BDD: src/__tests__/tab-context-menu/

import * as Menu from '@radix-ui/react-context-menu';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { MenuItem } from '@/design';
import { dispatchContextMenuAt, isContextMenuKey } from './context-menu-key';

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

// 与 Explorer ContextMenu / DropdownMenu 同一浮层外观。
const contentCls =
  'min-w-[180px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-popover outline-none';

/** 聚焦的 tab 上按 Shift+F10 / 菜单键 → 在该元素处派发 contextmenu(冒泡到 Trigger 打开菜单)。 */
function openFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
  if (!isContextMenuKey(event.nativeEvent)) return;
  // 阻止 Windows 再按默认行为派发一次 contextmenu。
  event.preventDefault();
  event.stopPropagation();
  dispatchContextMenuAt(event.target as HTMLElement);
}

export function TabContextMenu({
  entries,
  children,
}: {
  /** 打开时调用一次,构建菜单项。 */
  readonly entries: () => readonly TabMenuEntry[];
  /** 触发区(单个元素,Radix asChild 合并 contextmenu / keydown 处理)。 */
  readonly children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | undefined>(undefined);
  const skipFocusRestoreRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  return (
    <Menu.Root onOpenChange={setOpen}>
      <Menu.Trigger
        asChild
        onContextMenu={(e) => setPortalHost(e.currentTarget.ownerDocument.body)}
        onKeyDown={openFromKeyboard}
      >
        {children}
      </Menu.Trigger>
      {open && (
        <Menu.Portal container={portalHost}>
          <Menu.Content
            className={contentCls}
            collisionPadding={8}
            onCloseAutoFocus={(e) => {
              // opensDialog 项:不拦 Radix 的还原(焦点回到打开菜单前的 tab),还原后(同一任务内的微任务)再执行。
              const pending = pendingActionRef.current;
              if (pending) {
                pendingActionRef.current = null;
                queueMicrotask(pending);
                return;
              }
              if (!skipFocusRestoreRef.current) return;
              skipFocusRestoreRef.current = false;
              e.preventDefault();
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
