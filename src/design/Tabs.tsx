import './Tabs.css';
import { handleTablistArrowKeys } from './roving-tablist';

/**
 * A selectable tab descriptor.
 *
 * Use inside `<Tabs items={[{ id: 'preview', label: 'Preview' }]} ... />`.
 * Both `id` and `label` are required.
 */
export interface TabItem {
  /** Stable id passed back to `onSelect`. No default. */
  readonly id: string;
  /** Visible tab label. No default. */
  readonly label: string;
}

/**
 * Props for a vertical tab list.
 *
 * Use for local view switching such as `<Tabs items={items} activeId="preview" onSelect={setTab} />`.
 * No defaults are applied; callers provide items, active id, and selection handler.
 */
export interface TabsProps {
  /** Ordered tab items. No default. */
  readonly items: readonly TabItem[];
  /** Currently selected item id. No default. */
  readonly activeId: string;
  /** Called with the selected item id. No default. */
  readonly onSelect: (id: string) => void;
  /**
   * a11y(A108,A107 同型):role="tablist" 的可访问名。Caller 传本地化组名,否则 AT 进入只听
   * 泛化"tab list"。design 层无 i18n,文本由调用点注入。Defaults to none.
   */
  readonly ariaLabel?: string;
}

export function Tabs({ items, activeId, onSelect, ariaLabel }: TabsProps) {
  return (
    // a11y(A28,A23 同族):tablist 须配 WAI-ARIA 键盘模型(roving tabindex + 方向键导航)。
    <nav
      className="wm-tabs"
      role="tablist"
      // a11y(A108):caller 注入的本地化组名(design 层无 i18n)。
      aria-label={ariaLabel}
      onKeyDown={handleTablistArrowKeys}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="wm-tab-button"
          data-active={item.id === activeId}
          aria-selected={item.id === activeId}
          // roving tabindex:仅 active tab 在 Tab 顺序内,其余由方向键导航。
          tabIndex={item.id === activeId ? 0 : -1}
          onClick={() => { onSelect(item.id); }}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
