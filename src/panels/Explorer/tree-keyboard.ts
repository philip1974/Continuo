// 文件树键盘操作(对齐 VSCode Explorer),挂在树容器的 keydown(冒泡阶段,晚于 headless-tree
// hotkeysCoreFeature 在同一容器上的原生监听 —— 方向键等焦点移动已由库完成,这里只补「选中跟随焦点」)。
//
// 为何不走 headless-tree 的 hotkeys 配置 / onPrimaryAction:
//   - 库在每次行单击(含 ⌘ / Shift 多选单击)都调 primaryAction,接 onPrimaryAction 会让多选单击打开
//     文件、目录单击双重切换展开;Enter 改在这里调同一个「打开」。
//   - 库按 pressedKeys 集合精确匹配组合键,而 macOS 在按住 ⌘ 时不派发其它键的 keyup → ⌘C 后 KeyC
//     永远留在集合里,之后的方向键都因键数不等而失配。mod 组合键在这里匹配(平台判定同全局命令热键),
//     并从库的 pressedKeys 里摘掉按住 ⌘ 时按下的键(同库对 input 内按键的处理)。
import type {
  HotkeysCoreDataRef,
  ItemInstance,
  SelectionDataRef,
  TreeInstance,
} from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { dispatchContextMenuAt, isContextMenuKey } from '@/lib/context-menu-key';
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import type { Platform } from '@/plugins/command-palette/format-hotkey';
import { getContextActionTargets, type ContextMenuActions } from './ContextMenu';
import { dirname } from './path-utils';

export type TreeKeyCommand = 'open' | 'trash' | 'copy' | 'cut' | 'paste' | 'undo' | 'redo';

/** 剪切 / 复制 / 粘贴 / 重命名的树内键位(右键菜单右侧显示同一来源;树内键不经快捷键设置,不可改绑)。 */
export const TREE_KEY_HOTKEYS = { cut: 'mod+x', copy: 'mod+c', paste: 'mod+v', rename: 'f2' } as const;

/** 撤销 / 重做文件操作(VSCode explorer 同款):mod+Z 撤销;重做 mod+shift+Z,非 mac 另认 Ctrl+Y。 */
export const TREE_UNDO_HOTKEY = 'mod+z';
export const TREE_REDO_HOTKEY = 'mod+shift+z';

/** 移到废纸篓的主键位:mac ⌘⌫(另认 Delete),其它 Delete。 */
export function trashHotkey(platform: Platform): string {
  return platform === 'mac' ? 'cmd+backspace' : 'delete';
}

/**
 * VSCode Explorer 键位:Enter 打开(文件)/ 切换展开(目录);Delete 移到废纸篓(mac 另有 ⌘⌫);
 * mod+C / mod+X / mod+V 复制 / 剪切 / 粘贴(mod = mac ⌘、其它 Ctrl);mod+Z / mod+shift+Z(非 mac 另 Ctrl+Y)撤销 / 重做文件操作。
 */
export function matchTreeKeyCommand(e: KeyboardEvent, platform: Platform): TreeKeyCommand | null {
  if (matchesHotkey('enter', e, platform)) return 'open';
  if (matchesHotkey('delete', e, platform)) return 'trash';
  if (matchesHotkey(trashHotkey(platform), e, platform)) return 'trash';
  if (matchesHotkey(TREE_KEY_HOTKEYS.copy, e, platform)) return 'copy';
  if (matchesHotkey(TREE_KEY_HOTKEYS.cut, e, platform)) return 'cut';
  if (matchesHotkey(TREE_KEY_HOTKEYS.paste, e, platform)) return 'paste';
  if (matchesHotkey(TREE_UNDO_HOTKEY, e, platform)) return 'undo';
  if (matchesHotkey(TREE_REDO_HOTKEY, e, platform)) return 'redo';
  if (platform !== 'mac' && matchesHotkey('ctrl+y', e, platform)) return 'redo';
  return null;
}

/** 键入跳转的前缀缓冲:停顿超过此时长后重新开始(VSCode 列表 type navigation 同量级)。 */
export const TYPE_AHEAD_RESET_MS = 800;

/**
 * 在 names 中找名称以 query 开头(不分大小写)的项,从 fromIndex 起环绕查找。
 * query 是同一字符重复(如 b / bb)时从 fromIndex 的下一项开始 → 反复按同一字母在同首字母项间循环;
 * 否则从 fromIndex 自身开始(继续键入时当前项若仍匹配更长前缀就留在原地)。无匹配返回 -1。
 */
export function findTypeAheadIndex(
  names: readonly string[],
  fromIndex: number,
  query: string,
): number {
  const n = names.length;
  if (n === 0 || query.length === 0) return -1;
  // NFC:磁盘上 NFD 的名字(如 é = e + 组合重音)与键入的 NFC 字符对得上(VSCode macOS 上文件名读出即 NFC)。
  const q = query.normalize('NFC').toLowerCase();
  const first = q[0]!;
  let repeated = true;
  for (let i = 1; i < q.length; i++) {
    if (q[i] !== first) {
      repeated = false;
      break;
    }
  }
  const prefix = repeated ? first : q;
  const start = repeated ? fromIndex + 1 : fromIndex;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (names[i]!.normalize('NFC').toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

export interface TypeAheadState {
  query: string;
  at: number;
}

export interface TreeKeyContext {
  readonly tree: TreeInstance<FileEntry>;
  /** 实际渲染的行(隐藏文件过滤后);键入跳转只在其中找。 */
  readonly items: readonly ItemInstance<FileEntry>[];
  readonly actions: Pick<ContextMenuActions, 'onTrash' | 'onCopy' | 'onCut' | 'onPaste'>;
  /** 打开文件(与单击同一入口)。 */
  readonly openFile: (path: string) => void;
  readonly rootPath: string;
  readonly platform: Platform;
  /** 撤销 / 重做文件操作(见 file-undo.ts);未提供则不处理这两个键。 */
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  /** 键入跳转缓冲(调用方持有的可变对象)。 */
  readonly typeAhead: TypeAheadState;
  readonly now?: () => number;
  /**
   * PageDown / PageUp(VSCode list.focusPageDown / focusPageUp):调用方按可视区计算落点、必要时滚动,并把焦点 + 选中移过去。
   * 未提供则不处理这两个键。
   */
  readonly onPage?: (direction: 1 | -1) => void;
}

/** 翻页计算用的列表视图:各行高度(下标同虚拟列表的行)、滚动位置、可视高度;不可聚焦的行(读取失败行)跳过。 */
export interface PageView {
  readonly sizes: readonly number[];
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly isFocusable: (index: number) => boolean;
}

export interface PageTarget {
  readonly index: number;
  readonly scrollTop: number;
}

/**
 * PageDown / PageUp 的焦点落点与滚动位置,照 VSCode listWidget focusNextPage / focusPreviousPage:
 * - PageDown:焦点不在可视区末行(且在它之上 / 无焦点)→ 移到可视区末行;已在末行(或在可视区之下)→ 向下滚一整页,
 *   再移到新一页的末行。PageUp 对称(首个完整可见行,向上滚一整页)。
 * - 落点是不可聚焦行时就近找可聚焦行(PageDown 向上找、PageUp 向下找);找到的就是焦点本身 → 按「已在末行」继续翻页
 *  (VSCode 此时落到不可聚焦行;这里没有可聚焦的落点,翻页免得卡住)。滚不动且无新落点 → null(不动)。
 */
export function pageFocusTarget(view: PageView, focused: number | undefined, direction: 1 | -1): PageTarget | null {
  const { sizes, viewportHeight: height, isFocusable } = view;
  const count = sizes.length;
  if (count === 0) return null;
  const starts = new Array<number>(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    starts[i] = total;
    total += sizes[i]!;
  }
  const maxTop = Math.max(0, total - height);
  // VSCode rangeMap.indexAt:position 所在行;超出末尾 → count
  const indexAt = (pos: number): number => {
    if (pos >= total) return count;
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const findFocusable = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < count; i += step) if (isFocusable(i)) return i;
    return -1;
  };
  let top = Math.min(Math.max(0, view.scrollTop), maxTop);
  let f = focused;
  // VSCode 滚一页后清空焦点再递归一次:第二轮必定落点(或滚不动返回)
  for (let round = 0; round < 2; round++) {
    if (direction === 1) {
      let last = indexAt(top + height);
      last = last === 0 ? 0 : Math.min(last - 1, count - 1);
      if (f !== last && (f === undefined || last > f)) {
        const good = findFocusable(last, -1);
        if (good >= 0 && good !== f) return { index: good, scrollTop: top };
      }
      const next = Math.min(top + height, maxTop);
      if (next === top) return null;
      top = next;
    } else {
      const first = top === 0 ? indexAt(0) : Math.min(indexAt(top - 1) + 1, count - 1);
      if (f !== first && (f === undefined || f >= first)) {
        const good = findFocusable(first, 1);
        if (good >= 0 && good !== f) return { index: good, scrollTop: top };
      }
      const next = Math.max(0, top - height);
      if (next === top) return null;
      top = next;
    }
    f = undefined;
  }
  return null;
}

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Meta', 'Control', 'Shift', 'Alt']);

/**
 * 树对焦点项执行动作的无 ⌘ / Ctrl / Alt 按键(e.key;Shift 不论):headless-tree 在树容器上原生监听的
 * hotkeysCore / selection / renaming(方向键与 Shift+方向键、Home、End、F2、Enter)+ 本文件的 Enter / Delete
 * 与键入跳转里的空格。树内非行元素(读取失败行的「重试」)只截这些,其余(F5 等用户自绑的单键全局命令)照常冒泡。
 */
export const TREE_ITEM_PLAIN_KEYS: ReadonlySet<string> = new Set([
  ...NAVIGATION_KEYS,
  'Enter',
  'F2',
  'Delete',
  ' ',
]);

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * 树里非行元素上的按键(如子目录读取失败行里的「重试」按钮):树命令只作用于来自行本身(或树容器)的按键 ——
 * 否则焦点在「重试」上按 Enter 会收起焦点所在的失败目录、按 Delete 会删除它。
 */
function isNonItemTarget(target: EventTarget | null): boolean {
  // 鸭子类型而非 instanceof Element:popout 窗口里的元素属于另一个 realm
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function' || el.getAttribute('role') === 'tree') return false;
  return el.closest('[role="treeitem"]') === null;
}

/** 只选中 id 这一项,并把 Shift 扩选的锚点设到它。 */
export function selectOnly(tree: TreeInstance<FileEntry>, id: string): void {
  tree.setSelectedItems([id]);
  // Shift+单击 / Shift+方向键的范围起点也跟到这里(同库单击的锚点语义)
  tree.getDataRef<SelectionDataRef>().current.selectUpToAnchorId = id;
}

/** 焦点 + 选中都移到 item,并把 DOM 焦点移到该行(滚动到可见)。 */
export function focusAndSelect(tree: TreeInstance<FileEntry>, item: ItemInstance<FileEntry>): void {
  item.setFocused();
  selectOnly(tree, item.getId());
  tree.updateDomFocus();
}

/** 删除后焦点落点(VSCode:下一项,没有则上一项),跳过被删项及其子孙。 */
export function neighborAfterRemoval(
  items: readonly ItemInstance<FileEntry>[],
  fromIndex: number,
  removed: readonly string[],
): ItemInstance<FileEntry> | undefined {
  const gone = (id: string): boolean => removed.some((p) => isSameOrInsidePath(p, id));
  for (let i = fromIndex + 1; i < items.length; i++) if (!gone(items[i]!.getId())) return items[i];
  for (let i = fromIndex - 1; i >= 0; i--) if (!gone(items[i]!.getId())) return items[i];
  return undefined;
}

/**
 * 焦点项不再显示(折叠了它的祖先 / 「折叠全部」/ 外部删除 / 关掉显示隐藏文件)时焦点的去处:最近的仍显示的祖先目录;
 * 没有(在根下)→ 它原来下标处的行(越界取末行),该行不可聚焦(读取失败行)则就近找。ids:各行的 id,不可聚焦行为 null。
 * 无可聚焦行 → -1。
 */
export function focusFallbackIndex(
  ids: readonly (string | null)[],
  goneId: string,
  lastIndex: number,
  rootPath: string,
): number {
  const at = new Map<string, number>();
  ids.forEach((id, i) => {
    if (id !== null) at.set(id, i);
  });
  for (let p = dirname(goneId); isSameOrInsidePath(rootPath, p) && !pathEquals(p, rootPath); ) {
    const i = at.get(p);
    if (i !== undefined) return i;
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  const from = Math.min(Math.max(0, lastIndex), ids.length - 1);
  for (let i = from; i < ids.length; i++) if (ids[i] !== null) return i;
  for (let i = from - 1; i >= 0; i--) if (ids[i] !== null) return i;
  return -1;
}

/**
 * 树的焦点项,须是实际渲染的行:不在其中(如被过滤的隐藏文件、刷新途中已不显示的项)时视为无焦点项,不对它执行
 * 任何命令 —— 否则 Delete 会删掉用户看不见的项。
 */
function renderedFocusedItem(
  tree: TreeInstance<FileEntry>,
  items: readonly ItemInstance<FileEntry>[],
): ItemInstance<FileEntry> | undefined {
  const rawFocused = items.length > 0 ? tree.getFocusedItem() : undefined;
  const focusedId = rawFocused?.getId();
  return rawFocused && items.some((it) => it.getId() === focusedId) ? rawFocused : undefined;
}

/**
 * 以树焦点项为准的目标目录(VSCode Explorer 粘贴 / 新建文件 / 新建文件夹):目录 → 自身;文件 → 所在目录;
 * 无(渲染中的)焦点项 → 工作区根。
 */
export function focusedTargetDir(
  tree: TreeInstance<FileEntry>,
  items: readonly ItemInstance<FileEntry>[],
  rootPath: string,
): string {
  const focused = renderedFocusedItem(tree, items);
  if (!focused) return rootPath;
  return focused.isFolder() ? focused.getId() : dirname(focused.getId());
}

/**
 * 处理树容器上的 keydown。返回是否消费了该键(已 preventDefault + stopPropagation)。
 * 输入框(重命名)内的按键、重命名进行中一律不处理。
 */
export function handleTreeKeyDown(e: KeyboardEvent, ctx: TreeKeyContext): boolean {
  const { tree, items } = ctx;
  if (isEditableTarget(e.target) || isNonItemTarget(e.target) || tree.isRenamingItem()) return false;

  // macOS 按住 ⌘ 时其它键不派发 keyup:从库的按键集合里摘掉,否则之后的方向键全部失配。
  if (e.metaKey && !MODIFIER_KEYS.has(e.key)) {
    tree.getDataRef<HotkeysCoreDataRef>().current.pressedKeys?.delete(e.code || e.key);
  }

  const rawFocused = items.length > 0 ? tree.getFocusedItem() : undefined;
  const focused = renderedFocusedItem(tree, items);

  // Shift+F10 / 菜单键(VSCode 列表同):在焦点行左下角打开该行的右键菜单 —— 行的 contextmenu 处理与鼠标右键同一路径
  //(多选时焦点行在选中集内 → 作用于选中集)。焦点行不在 DOM(虚拟列表滚出)或无焦点行 → 在按键目标(树容器)处打开空白菜单。
  // 菜单关闭后 Radix 把焦点还给打开前的焦点元素(即该行)。
  if (isContextMenuKey(e)) {
    const el = focused?.getElement() ?? (e.target as HTMLElement | null);
    if (!el || typeof el.dispatchEvent !== 'function') return false;
    e.preventDefault();
    e.stopPropagation();
    dispatchContextMenuAt(el);
    return true;
  }

  const command = matchTreeKeyCommand(e, ctx.platform);
  if (command !== null) {
    const consume = (): true => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
    // 撤销 / 重做不依赖焦点项(作用于本工作区的文件操作栈)
    if (command === 'undo' || command === 'redo') {
      const run = command === 'undo' ? ctx.onUndo : ctx.onRedo;
      if (!run) return false;
      run();
      return consume();
    }
    if (rawFocused && !focused) return false;
    if (command === 'paste') {
      ctx.actions.onPaste(focusedTargetDir(tree, items, ctx.rootPath));
      return consume();
    }
    if (!focused) return false;
    if (command === 'open') {
      selectOnly(tree, focused.getId());
      if (focused.isFolder()) {
        if (focused.isExpanded()) focused.collapse();
        else focused.expand();
      } else {
        ctx.openFile(focused.getId());
      }
      return consume();
    }
    // 选中集合与实际渲染的行取交集(防御:关掉「显示隐藏文件」时 FolderTree 已修剪选中,这里再挡一次)——
    // 看不见的项不被删除 / 剪切 / 复制。
    const rendered = new Set<string>();
    for (const it of items) rendered.add(it.getId());
    const selected = new Set<string>();
    for (const id of tree.getState().selectedItems ?? []) if (rendered.has(id)) selected.add(id);
    const targets = getContextActionTargets(focused.getItemData(), selected);
    if (command === 'copy') ctx.actions.onCopy(targets);
    else if (command === 'cut') ctx.actions.onCut(targets);
    else {
      // 按住 Delete 的自动重复不连删(第一次按下已发起删除 / 确认)
      if (e.repeat) return consume();
      const index = items.findIndex((it) => it.getId() === focused.getId());
      const next = neighborAfterRemoval(items, index, targets);
      // 焦点落点在确认后才移(取消删除则焦点 / 选中不动)
      ctx.actions.onTrash(targets, () => {
        if (next) focusAndSelect(tree, next);
      });
    }
    return consume();
  }

  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  // PageDown / PageUp(VSCode list.focusPageDown / focusPageUp,只绑无修饰键;Shift+PageDown 在 VSCode 也无绑定 → 不处理)
  if ((e.key === 'PageDown' || e.key === 'PageUp') && plain && !e.shiftKey) {
    if (!ctx.onPage || tree.getState().dnd) return false;
    e.preventDefault(); // 不让浏览器再滚一次滚动容器
    e.stopPropagation();
    ctx.onPage(e.key === 'PageDown' ? 1 : -1);
    return true;
  }
  // 焦点移动已由 headless-tree 在同一 keydown 的更早监听里完成;这里让选中跟上(Shift 扩选由库处理)。
  if (NAVIGATION_KEYS.has(e.key)) {
    // → 在文件上无动作(VSCode list.expand 的 when 不含叶子;见 tree-config expandOrDown):焦点没动,选中也不动(保留多选)
    if (e.key === 'ArrowRight' && focused && !focused.isFolder()) return false;
    // focused 已是库移动后的焦点项(且是渲染行,见上)
    if (plain && !e.shiftKey && focused && !tree.getState().dnd) selectOnly(tree, focused.getId());
    return false;
  }

  // 键入跳转:可打印单字符、无 Ctrl / ⌘ / Alt;空格只在已有前缀时算进前缀。
  if (!plain || e.key.length !== 1 || items.length === 0) return false;
  const ta = ctx.typeAhead;
  const t = (ctx.now ?? Date.now)();
  if (t - ta.at > TYPE_AHEAD_RESET_MS) ta.query = '';
  if (e.key === ' ' && ta.query === '') return false;
  ta.query += e.key;
  ta.at = t;
  const fromId = focused?.getId();
  const fromIndex = Math.max(
    0,
    items.findIndex((it) => it.getId() === fromId),
  );
  const names = items.map((it) => it.getItemData().name);
  const index = findTypeAheadIndex(names, fromIndex, ta.query);
  e.preventDefault();
  e.stopPropagation();
  if (index >= 0) focusAndSelect(tree, items[index]!);
  return true;
}
