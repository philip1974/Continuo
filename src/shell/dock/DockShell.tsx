import { useCallback, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { panelComponents } from './panels';
import { applyDefaultLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { SharedTab } from '@/shell/motion/SharedTab';
import { debounce } from '@/lib/debounce';
import '@/styles/dockview.css';

const tabComponents = { default: SharedTab };

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [empty, setEmpty] = useState(false);

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const persisted = await window.api.layout.read();

      let restored = false;
      if (persisted && typeof persisted === 'object') {
        try {
          event.api.fromJSON(persisted as SerializedDockview);
          restored = true;
        } catch (err) {
          console.warn('[dock] fromJSON 失败,落回默认布局', err);
        }
      }
      if (!restored) applyDefaultLayout(event.api);
      setEmpty(event.api.totalPanels === 0);
      onLayoutReady?.();

      const persist = debounce(() => {
        const snapshot = event.api.toJSON() as unknown;
        const payload = { version: 1 as const, ...(snapshot as object) };
        void window.api.layout.write(payload);
      }, 300);

      event.api.onDidLayoutChange(() => {
        persist();
        setEmpty(event.api.totalPanels === 0);
      });
    },
    [onLayoutReady],
  );

  const restore = useCallback(() => {
    if (apiRef.current) applyDefaultLayout(apiRef.current);
  }, []);

  return (
    <div className="relative h-full w-full">
      <DockviewReact
        components={panelComponents}
        tabComponents={tabComponents}
        defaultTabComponent={SharedTab}
        rightHeaderActionsComponent={HeaderActions}
        onReady={onReady}
        className="dockview-theme-abyss h-full w-full"
      />
      {empty && <EmptyState onRestore={restore} />}
    </div>
  );
}
