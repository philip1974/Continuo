import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import type { PanelKey } from './panels';

const choices: { key: PanelKey; label: string }[] = [
  { key: 'editor', label: 'Editor' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'output', label: 'Output' },
  { key: 'explorer', label: 'Explorer' },
];

let panelCounter = 0;
const nextPanelId = (key: PanelKey) => `${key}-${++panelCounter}`;

export function AddPanelButton(props: IDockviewHeaderActionsProps) {
  const { containerApi, group } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  const addPanel = useCallback(
    (key: PanelKey, label: string) => {
      const id = nextPanelId(key);
      containerApi.addPanel({
        id,
        component: key,
        title: label,
        position: { referenceGroup: group },
      });
      setOpen(false);
    },
    [containerApi, group],
  );

  return (
    <div ref={ref} className="relative flex h-full items-center pr-1">
      <button
        type="button"
        aria-label="New tab"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border border-white/10 bg-neutral-900 py-1 text-sm shadow-lg shadow-black/40">
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => addPanel(c.key, c.label)}
              className="flex w-full items-center px-3 py-1.5 text-left text-neutral-200 hover:bg-white/5"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
