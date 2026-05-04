import './Tabs.css';

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
}

export function Tabs({ items, activeId, onSelect }: TabsProps) {
  return (
    <nav className="wm-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="wm-tab-button"
          data-active={item.id === activeId}
          aria-selected={item.id === activeId}
          onClick={() => { onSelect(item.id); }}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
