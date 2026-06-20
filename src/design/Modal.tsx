import './Modal.css';
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

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
  /** Called on overlay click or Escape. Optional. */
  readonly onClose?: () => void;
  /** Width preset.`sm` (480px / 默认 / permission / auth) | `md` (560px / command palette) |
   * `lg` (640px / quick open / file picker). 取代调用方 `!max-w-[Npx]` 的零散写法。 */
  readonly size?: ModalSize;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Continuo-local 微调:多 Modal 叠加时,键盘(Esc/Tab)只由最顶层(最后打开)的 Modal 处理。
// Nous 上游每个 Modal 都在 document 挂独立 keydown 监听、叠加时单次 Esc 连带触发所有打开
// Modal 的 onClose —— 在 Continuo 里 CommandPalette 开着时 agent 推来的 AgentAuthPrompt
// (onClose=deny)/ PermissionPrompt(onClose=denyAll)会被这次 Esc 静默拒绝(安全决策被误触)。
// 此 top-most 栈是通用增强,应推回 Nous(任务卡记 doc/)。见第十八轮 P1-AU。
const modalKeyStack: symbol[] = [];

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
  if (keyIdRef.current == null) keyIdRef.current = Symbol('modal');

  useEffect(() => {
    if (!visible) return undefined;

    prevFocusRef.current = (globalThis.document.activeElement as HTMLElement | null) ?? null;

    const keyId = keyIdRef.current!;
    modalKeyStack.push(keyId);

    const raf = requestAnimationFrame(() => {
      const root = contentRef.current;
      if (root == null) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      if (first != null) first.focus();
      else root.focus();
    });

    const handleKey = (e: globalThis.KeyboardEvent) => {
      // 只有栈顶(最后打开)的 Modal 处理键盘,叠加时背后的 Modal 不被连带 Esc 关闭。
      if (modalKeyStack[modalKeyStack.length - 1] !== keyId) return;
      if (e.key === 'Escape' && onClose != null) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = contentRef.current;
      if (root == null) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables.at(0);
      const last = focusables.at(-1);
      if (first == null || last == null) {
        e.preventDefault();
        return;
      }
      const active = globalThis.document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    globalThis.document.addEventListener('keydown', handleKey);

    return () => {
      cancelAnimationFrame(raf);
      globalThis.document.removeEventListener('keydown', handleKey);
      const idx = modalKeyStack.lastIndexOf(keyId);
      if (idx >= 0) modalKeyStack.splice(idx, 1);
      const prev = prevFocusRef.current;
      if (prev != null && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <div
      className="wm-modal-overlay"
      onClick={onClose != null ? onClose : undefined}
      aria-hidden="true"
    >
      <div
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
