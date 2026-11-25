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
import { isSameOrInsidePath } from '@/lib/path-cross';
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import type { Platform } from '@/plugins/command-palette/format-hotkey';
import { getContextActionTargets, type ContextMenuActions } from './ContextMenu';
import { dirname } from './path-utils';

export type TreeKeyCommand = 'open' | 'trash' | 'copy' | 'cut' | 'paste';

/**
 * VSCode Explorer 键位:Enter 打开(文件)/ 切换展开(目录);Delete 移到废纸篓(mac 另有 ⌘⌫);
 * mod+C / mod+X / mod+V 复制 / 剪切 / 粘贴(mod = mac ⌘、其它 Ctrl)。
 */
export function matchTreeKeyCommand(e: KeyboardEvent, platform: Platform): TreeKeyCommand | null {
  if (matchesHotkey('enter', e, platform)) return 'open';
  if (matchesHotkey('delete', e, platform)) return 'trash';
  if (platform === 'mac' && matchesHotkey('cmd+backspace', e, platform)) return 'trash';
  if (matchesHotkey('mod+c', e, platform)) return 'copy';
  if (matchesHotkey('mod+x', e, platform)) return 'cut';
  if (matchesHotkey('mod+v', e, platform)) return 'paste';
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
  const q = query.toLowerCase();
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
    if (names[i]!.toLowerCase().startsWith(prefix)) return i;
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
  /** 键入跳转缓冲(调用方持有的可变对象)。 */
  readonly typeAhead: TypeAheadState;
  readonly now?: () => number;
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
  const command = matchTreeKeyCommand(e, ctx.platform);
  if (command !== null) {
    if (rawFocused && !focused) return false;
    const consume = (): true => {
      e.preventDefault();
      e.stopPropagation();
      return true;
    };
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
  // 焦点移动已由 headless-tree 在同一 keydown 的更早监听里完成;这里让选中跟上(Shift 扩选由库处理)。
  if (NAVIGATION_KEYS.has(e.key)) {
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
