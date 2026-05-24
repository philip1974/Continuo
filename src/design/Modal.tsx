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

  useEffect(() => {
    if (!visible) return undefined;

    prevFocusRef.current = (globalThis.document.activeElement as HTMLElement | null) ?? null;

    const raf = requestAnimationFrame(() => {
      const root = contentRef.current;
      if (root == null) return;
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      if (first != null) first.focus();
      else root.focus();
    });

    const handleKey = (e: globalThis.KeyboardEvent) => {
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
