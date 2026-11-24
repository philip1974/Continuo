// 真实 dockview(jsdom)+ 假 popout 子窗(iframe 的 window 充当 window.open 返回值)。
import { vi } from 'vitest';
import { DockviewComponent } from 'dockview-react';

// jsdom 无 ResizeObserver,dockview 构造时需要;布局尺寸与本主题无关,给空实现。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

export function createDock(): DockviewComponent {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new DockviewComponent(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
    }),
  });
}

export interface FakePopout {
  /** 用户关掉子窗(dockview 监听子窗 beforeunload)。 */
  close(): void;
}

/** 把面板弹到一个假子窗:window.open 返回 iframe.contentWindow,并触发其 load。 */
export async function openFakePopout(dock: DockviewComponent, panelId: string): Promise<FakePopout> {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const child = iframe.contentWindow!;
  const spy = vi.spyOn(window, 'open').mockImplementation(() => {
    queueMicrotask(() => child.dispatchEvent(new Event('load')));
    return child;
  });
  const panel = dock.getGroupPanel(panelId);
  if (!panel) throw new Error(`no panel ${panelId}`);
  const ok = await dock.api.addPopoutGroup(panel);
  spy.mockRestore();
  if (!ok) throw new Error('popout failed');
  return { close: () => child.dispatchEvent(new Event('beforeunload')) };
}
