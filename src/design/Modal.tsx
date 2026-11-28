import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { isImeComposing } from './ime';
import { focusWithinOrLost } from './focus-within-or-lost';

type ModalSize = 'sm' | 'md' | 'lg';

/**
 * Props for a focus-trapped modal surface.
 *
 * Use for dialogs such as `<Modal visible onClose={close}>...</Modal>`.
 * `visible` is required, `onClose` is optional, and children are rendered only when visible.
 */
export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  /** Whether the modal is mounted and focus-trapped. No default. */
  readonly visible: boolean;
  /** Dialog content. No default. */
  readonly children: ReactNode;
  /** Called on Escape, or on an overlay click whose press also started on the overlay. Optional. */
  readonly onClose?: () => void;
  /** Width preset.`sm` (480px / 默认 / permission / auth) | `md` (560px / command palette) |
   * `lg` (640px / quick open / file picker). 取代调用方 `!max-w-[Npx]` 的零散写法。 */
  readonly size?: ModalSize;
}

/** 焦点陷阱认定的可聚焦元素(授权弹窗的防误触守卫复用,须同一口径)。 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Continuo-local 微调:多 Modal 叠加时,键盘(Esc/Tab)只由最顶层(最后打开)的 Modal 处理。
// 若每个 Modal 都在 document 挂独立 keydown 监听,叠加时单次 Esc 会连带触发所有打开 Modal 的 onClose ——
// CommandPalette 开着时 agent 推来的 AgentAuthPrompt(onClose=deny)/ PermissionPrompt(onClose=denyAll)
// 会被这次 Esc 静默拒绝(安全决策被误触)。见第十八轮 P1-AU。
// 栈按 Modal 所在文档分开:dockview popout 子窗与主窗的按键互不传播,各文档只看自己的栈顶 —— 共用一个栈时,子窗
// 确认框开着、主窗又弹出授权框,子窗框的 Esc / Tab 焦点陷阱就失效(反之亦然)。
const modalKeyStacks = new WeakMap<Document, symbol[]>();

function modalKeyStackOf(doc: Document): symbol[] {
  let stack = modalKeyStacks.get(doc);
  if (stack === undefined) {
    stack = [];
    modalKeyStacks.set(doc, stack);
  }
  return stack;
}

// 打开中的 Modal 总数(所有文档合计)与订阅者:供上层在「有模态遮罩」时调整行为(如暂停被遮住的浮层计时)。
let openModalCount = 0;
const openModalListeners = new Set<() => void>();

function changeOpenModalCount(delta: 1 | -1): void {
  const before = openModalCount > 0;
  openModalCount += delta;
  if (before !== openModalCount > 0) {
    for (const listener of [...openModalListeners]) listener();
  }
}

/** 当前是否有打开(visible)的 Modal —— 任一文档(主窗或 popout 子窗)均计入。 */
export function hasOpenModal(): boolean {
  return openModalCount > 0;
}

/**
 * 该文档(主窗或某个 popout 子窗)里打开的 Modal 是否多于 `besides` 个。工作台快捷键据此在对话框打开时不执行
 *(对齐 VSCode);调用方自己的 Modal 不算时传 1(如 Quick Open / 命令面板的开关键)。
 */
export function hasOpenModalIn(doc: Document, besides = 0): boolean {
  return (modalKeyStacks.get(doc)?.length ?? 0) > besides;
}

// 每个打开中的 Modal 的内容节点(按其键盘栈条目):供 getTopModalContent 查询顶层模态。
const modalContents = new Map<symbol, HTMLElement>();

/**
 * 该文档最后打开、仍可见的 Modal 内容节点(`.wm-modal-content`);没有时为 null。`aria-modal` 让读屏忽略对话框外的
 * 节点,需要在模态打开时仍被读到的内容(如全局播报 live region)可放进这里。
 */
export function getTopModalContent(doc: Document): HTMLElement | null {
  const stack = modalKeyStacks.get(doc);
  const top = stack?.[stack.length - 1];
  return top === undefined ? null : (modalContents.get(top) ?? null);
}

/** 订阅「是否有打开的 Modal」的变化(仅在有 / 无切换时调用 listener);返回退订函数。 */
export function subscribeOpenModals(listener: () => void): () => void {
  openModalListeners.add(listener);
  return () => {
    openModalListeners.delete(listener);
  };
}

export function Modal({
  visible,
  children,
  className,
  onClose,
  size = 'sm',
  ...rest
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const keyIdRef = useRef<symbol | null>(null);
  const overlayPressedRef = useRef(false);
  if (keyIdRef.current == null) keyIdRef.current = Symbol('modal');

  useEffect(() => {
    if (!visible) return undefined;

    // 键盘 / 焦点都按 Modal 内容所在文档处理:面板弹出到 dockview popout 子窗时,Modal 随面板经 portal
    // 渲染在子窗 DOM,而代码运行在主窗(globalThis.document 是主窗)。Modal 自身不 portal,内容即在此文档。
    const doc = contentRef.current?.ownerDocument ?? globalThis.document;
    prevFocusRef.current = (doc.activeElement as HTMLElement | null) ?? null;

    const keyId = keyIdRef.current!;
    const modalKeyStack = modalKeyStackOf(doc);
    modalKeyStack.push(keyId);
    // 卸载清理时 ref 已被 React 清空,先留住内容节点供关闭时判断焦点是否还在弹窗里。
    const content = contentRef.current;
    if (content != null) modalContents.set(keyId, content);
    changeOpenModalCount(1);

    // Continuo-local 微调(a11y A20):初始焦点优先落到调用方用 [data-autofocus] 显式标记的
    // 可聚焦元素(如 ConfirmDialog 的确认按钮),找不到再回退第一个可聚焦元素(不忽略调用方意图、
    // 一律聚焦 first)。用 data-autofocus 而非 React
    // autoFocus:后者在 commit 期 imperatively 聚焦、不渲染 DOM 属性(无法在此查到),且会
    // 污染 prevFocus 还原。
    // 弹窗容器自身标 [data-autofocus](调用方经 props 传入)→ 初始焦点落在容器上、不落在任何按钮上:出现时机由对方决定的
    // 授权弹窗(用户可能正在打字,空格 / 回车不能落在按钮上),读屏仍读出 aria-labelledby / describedby,Tab 进入按钮。
    const focusInitial = () => {
      const root = contentRef.current;
      if (root == null) return;
      if (root.hasAttribute('data-autofocus')) {
        root.focus();
        return;
      }
      const explicit = root.querySelector<HTMLElement>(
        '[data-autofocus]:not([disabled])',
      );
      if (explicit != null) {
        explicit.focus();
        return;
      }
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      if (first != null) first.focus();
      else root.focus();
    };
    const raf = requestAnimationFrame(focusInitial);

    // 打开后、用户还没按键 / 点按之前,焦点被程序移出弹窗(如 headless-tree 拖放后在定时器里轮询聚焦源行,
    // 晚于上面的 rAF)→ 拉回初始焦点(对齐 VSCode Dialog:焦点离开对话框即拉回)。只管用户操作前:之后
    // 焦点去向以用户为准;落到另一个 Modal(叠加弹出,含其 commit 期 autoFocus)或本 Modal 已不在栈顶时不管。
    let userActed = false;
    const markUserActed = () => {
      userActed = true;
    };
    const handleFocusIn = (e: FocusEvent) => {
      if (userActed || modalKeyStack[modalKeyStack.length - 1] !== keyId) return;
      const target = e.target as Element | null;
      if (target == null || typeof target.closest !== 'function') return;
      if (target.closest('.wm-modal-content') != null) return;
      focusInitial();
    };

    const handleKey = (e: globalThis.KeyboardEvent) => {
      // 只有栈顶(最后打开)的 Modal 处理键盘,叠加时背后的 Modal 不被连带 Esc 关闭。
      if (modalKeyStack[modalKeyStack.length - 1] !== keyId) return;
      if (e.key === 'Escape' && onClose != null) {
        // 输入法组合中的 Esc 是取消组合(拼音 / 日文候选),不是关闭弹窗 —— 否则 Quick Open / 命令面板里取消候选会
        // 连带关掉面板、丢掉已输入的查询(各输入框处理自身 Esc 前都已判,Modal 的 document 级监听此前漏了)。
        if (isImeComposing(e)) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = contentRef.current;
      if (root == null) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first == null || last == null) {
        e.preventDefault();
        return;
      }
      const active = doc.activeElement;
      // 焦点在容器自身(初始焦点):Shift+Tab 浏览器会把焦点移出弹窗 → 回绕到最后一个(Tab 自然进入第一个)。
      if (e.shiftKey && active === root) {
        e.preventDefault();
        last.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    doc.addEventListener('keydown', handleKey);
    doc.addEventListener('focusin', handleFocusIn, true);
    doc.addEventListener('keydown', markUserActed, true);
    doc.addEventListener('pointerdown', markUserActed, true);

    return () => {
      cancelAnimationFrame(raf);
      doc.removeEventListener('keydown', handleKey);
      doc.removeEventListener('focusin', handleFocusIn, true);
      doc.removeEventListener('keydown', markUserActed, true);
      doc.removeEventListener('pointerdown', markUserActed, true);
      const idx = modalKeyStack.lastIndexOf(keyId);
      if (idx >= 0) modalKeyStack.splice(idx, 1);
      modalContents.delete(keyId);
      changeOpenModalCount(-1);
      // 只在焦点仍在弹窗里(内容已随关闭移除 → 落到 body)时还原;关闭期间焦点已被移到弹窗外(如命令面板执行的
      // 命令聚焦了别处)→ 不覆盖(VSCode Quick Input 同:隐藏后命令自己的焦点为准)。
      const prev = prevFocusRef.current;
      if (focusWithinOrLost(doc, content) && prev != null && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <div
      className="wm-modal-overlay"
      // 只有「按下与松开都在遮罩本身」才算点遮罩:在内容区按下(拖选输入框文字)、拖到遮罩上松开时,
      // 浏览器把 click 派给公共祖先(遮罩),据此关闭会丢掉命令面板 / Quick Open 的查询、误拒授权弹窗。
      onMouseDown={(e) => {
        overlayPressedRef.current = e.target === e.currentTarget;
      }}
      onClick={
        onClose != null
          ? (e) => {
              const pressedOnOverlay = overlayPressedRef.current;
              overlayPressedRef.current = false;
              if (pressedOnOverlay && e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      {/* Continuo-local 微调(a11y):content 标记为 role=dialog + aria-modal,配合已有 focus
          trap 成完整无障碍弹窗。**移除 overlay 原 aria-hidden="true"** —— 它包裹了 content,
          会让屏幕阅读器忽略整个弹窗内容、且焦点被 trap 进 aria-hidden 子树。role/aria-modal 置于 {...rest} 前,允许调用方覆盖(如传 aria-labelledby)。 */}
      <div
        role="dialog"
        aria-modal="true"
        {...rest}
        ref={contentRef}
        tabIndex={-1}
        data-size={size}
        onClick={(e) => {
          e.stopPropagation();
        }}
        className={`wm-modal-content${className != null ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
