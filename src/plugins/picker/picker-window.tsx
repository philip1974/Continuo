// 选择器(Quick Open / 转到行 / 命令面板 / 打开最近)画在触发它的窗口(VSCode:QuickInputService 显示时把 Quick Input
// 移到 layoutService.activeContainer —— 辅助窗口里打开就画在辅助窗口)。打开时 picker 切片记下触发窗口(hostDocument,
// 与热键 / 菜单 / 命令面板同一个 getCommandDocument),PickerPortal 把 Modal 经 createPortal 画进该 popout 子窗(design
// Modal 不 portal,键盘与焦点按内容所在文档处理);该子窗关闭 → 选择器随之关闭(不退回主窗:焦点不在那边)。
// BDD: src/__tests__/popout-picker/

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { StoreApi, UseBoundStore } from 'zustand';
import { getPopoutDocuments, subscribePopoutDocuments } from '@/shell/dock/popout-documents';
import { focusMainWindowFromPopout } from '@/shell/dock/main-window-focus';
import type { PickerSlice } from './picker-slice';

export function PickerPortal<S extends PickerSlice>({
  store,
  children,
}: {
  readonly store: UseBoundStore<StoreApi<S>>;
  readonly children: ReactNode;
}) {
  const isOpen = store((s) => s.isOpen);
  const hostDocument = store((s) => s.hostDocument);
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  const live = hostDocument !== null && popoutDocs.includes(hostDocument);
  useEffect(() => {
    if (!isOpen) return;
    // 打开所在的子窗已关闭(组移回主窗 / 关窗)→ 关闭选择器
    if (hostDocument !== null && !live) store.getState().close();
    // 画在主窗而焦点在某个子窗(没有标明触发窗口的入口)→ 激活主窗,焦点与选择器在同一窗口
    else if (hostDocument === null) focusMainWindowFromPopout();
  }, [isOpen, hostDocument, live, store]);
  if (hostDocument === null) return <>{children}</>;
  return live ? createPortal(children, hostDocument.body) : null;
}
