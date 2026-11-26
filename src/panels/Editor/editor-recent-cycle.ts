// ⌃Tab / ⌃⇧Tab:按编辑器组内最近使用顺序(MRU)切换编辑器(VSCode workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup /
// quickOpenLeastRecentlyUsedEditorInGroup 的极简版:不弹选择器,直接切过去)。
// - 一次「导航」:按住修饰键期间连按,沿**开始时**的 MRU 快照依次前进(⌃Tab)/ 后退(⌃⇧Tab,首按落到最久未用的),首尾相接 ——
//   不会因每次切换都改写 MRU 而在两个 tab 间来回跳;
// - 松开修饰键(keyup 时 ⌃ / ⌘ / ⌥ 都已松开)、窗口失焦、或期间别处换了活动 tab / 组内 tab 增删 → 导航结束,下次按从新的 MRU 开始;
// - 组 MRU 只把最终落到的 tab 提到最前,途经的 tab 保持原相对顺序(VSCode:选择器里浏览不改变 MRU);
// - 后退 / 前进(navigation-history)只记一次导航最后落到的编辑器;
// - 作用于触发它的窗口的编辑器组(commandEditorGroupId;popout 子窗里按作用于子窗的组);编辑器组不是该窗口 dock 的活动面板
//  (焦点在同组的终端里按)→ 先激活编辑器组面板;切过去的编辑器获焦(VSCode:选中后焦点进编辑器,终端里按也一样)。
// BDD: src/__tests__/editor-recent-cycle/

import {
  defaultTabMru,
  groupActiveTabIdOf,
  groupTabMruOf,
  groupTabsOf,
  useEditorStore,
} from '@/stores/editor.store';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { commandEditorGroupId } from './editor-groups-actions';
import { requestEditorFocus } from './editor-focus-registry';
import { replacingNavigationEntry } from './navigation-history';

/** 命令 id 与默认键(VSCode 同:mac / Windows / Linux 都是 ⌃Tab / ⌃⇧Tab)。 */
export const RECENT_EDITOR_IN_GROUP_COMMAND = {
  id: 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup',
  hotkey: 'ctrl+tab',
} as const;
export const LEAST_RECENT_EDITOR_IN_GROUP_COMMAND = {
  id: 'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup',
  hotkey: 'ctrl+shift+tab',
} as const;

interface Navigation {
  readonly groupId: string;
  /** 开始时的组内 MRU 快照(首项 = 开始时的活动 tab)。 */
  readonly order: readonly string[];
  index: number;
  /** 本次导航最后切到的 tab(活动 tab 不再是它 → 别处改了,导航作废)。 */
  current: string;
  readonly dispose: () => void;
}

let navigation: Navigation | null = null;

/** 结束当前导航(松开修饰键 / 失焦)。 */
export function endRecentEditorNavigation(): void {
  const n = navigation;
  navigation = null;
  n?.dispose();
}

function sameMembers(order: readonly string[], ids: readonly string[]): boolean {
  if (order.length !== ids.length) return false;
  const set = new Set(ids);
  return order.every((id) => set.has(id));
}

/** 组内 tab 的 MRU 全序:记录过的在前,从未激活过的按组内顺序排在后面。 */
function groupMruOrder(groupId: string): readonly string[] {
  const s = useEditorStore.getState();
  const ids = groupTabsOf(s, groupId).map((tab) => tab.id);
  const mru = groupTabMruOf(s, groupId) ?? defaultTabMru(ids, groupActiveTabIdOf(s, groupId));
  const inGroup = new Set(ids);
  const out = mru.filter((id) => inGroup.has(id));
  const seen = new Set(out);
  for (const id of ids) if (!seen.has(id)) out.push(id);
  return out;
}

/** 监听导航结束:该窗口里修饰键全部松开、窗口失焦。 */
function watchNavigationEnd(doc: Document): () => void {
  const win = doc.defaultView;
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) endRecentEditorNavigation();
  };
  const onBlur = (): void => endRecentEditorNavigation();
  // 捕获阶段:终端 / 编辑器截住的按键也要看到
  doc.addEventListener('keyup', onKeyUp, true);
  win?.addEventListener('blur', onBlur);
  return () => {
    doc.removeEventListener('keyup', onKeyUp, true);
    win?.removeEventListener('blur', onBlur);
  };
}

/**
 * 沿组内 MRU 前进(delta = 1,⌃Tab)/ 后退(delta = -1,⌃⇧Tab)一步并切过去。组内 tab < 2 → no-op。
 */
export function openRecentlyUsedEditorInGroup(delta: 1 | -1): void {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return;
  const doc = getCommandDocument();
  const s = useEditorStore.getState();
  const active = groupActiveTabIdOf(s, groupId);
  let nav = navigation;
  let started = false;
  if (
    !nav ||
    nav.groupId !== groupId ||
    nav.current !== active ||
    !sameMembers(nav.order, groupTabsOf(s, groupId).map((tab) => tab.id))
  ) {
    endRecentEditorNavigation();
    const order = groupMruOrder(groupId);
    if (order.length < 2) return;
    nav = { groupId, order, index: 0, current: order[0]!, dispose: watchNavigationEnd(doc) };
    navigation = nav;
    started = true;
  }
  const n = nav.order.length;
  nav.index = (nav.index + delta + n) % n;
  const target = nav.order[nav.index]!;
  nav.current = target;
  // 编辑器组面板不是该窗口 dock 的活动面板(同组里终端在前)→ 先显示它
  const api = getDockApi();
  const panel = api?.getPanel(groupId);
  if (panel) activateDockPanel(panel);
  // 后退 / 前进的导航记录:一次导航只记最后落到的编辑器(首按新记一条,之后的连按替换它;BDD: src/__tests__/editor-navigation-history/)
  if (started) s.switchTab(target, { groupId });
  else replacingNavigationEntry(() => s.switchTab(target, { groupId }));
  // 途经的 tab 不改变 MRU:只把落到的 tab 提到最前,其余按开始时的顺序
  useEditorStore.getState().restoreTabMru(groupId, [target, ...nav.order.filter((id) => id !== target)]);
  requestEditorFocus(target, groupId);
}
