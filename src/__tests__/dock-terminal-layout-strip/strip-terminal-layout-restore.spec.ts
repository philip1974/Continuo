// @vitest-environment jsdom
// 剥离终端后的 popout / floating 布局能被真实 dockview fromJSON 恢复。见 ./README.md。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DockviewComponent, type SerializedDockview } from 'dockview-react';
import { stripTerminalPanelsFromLayout } from '@/shell/dock/strip-terminal-layout';

// jsdom 无 ResizeObserver,dockview 构造时需要;布局尺寸与本规范无关,给空实现。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const createDock = () => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new DockviewComponent(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
    }),
  });
};

// 「+」开终端(与 editor 同组)后弹出 editor:grid 的引用组只剩终端,editor 在 popout。
const savedWithPopout = {
  grid: {
    root: {
      type: 'branch',
      size: 800,
      data: [{ type: 'leaf', size: 1200, data: { id: '1', views: ['term-1'], activeView: 'term-1' } }],
    },
    width: 1200,
    height: 800,
    orientation: 'HORIZONTAL',
  },
  panels: {
    editor: { id: 'editor', contentComponent: 'editor', title: 'Editor' },
    'term-1': { id: 'term-1', contentComponent: 'terminal', title: 'Terminal' },
  },
  activeGroup: '1',
  popoutGroups: [
    {
      data: { id: '2', views: ['editor'], activeView: 'editor' },
      gridReferenceGroup: '1',
      position: { top: 0, left: 0, width: 600, height: 400 },
      url: 'popout.html?popout=1',
    },
  ],
} as unknown as SerializedDockview;

describe('剥离终端后的布局交给真实 dockview fromJSON 恢复', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('popout:引用组随布局恢复,弹窗被拦截时 editor 回落到该引用组(锚点有效)', async () => {
    const stripped = stripTerminalPanelsFromLayout(savedWithPopout);
    expect(stripped).not.toBeNull();
    // jsdom 无法真开窗口:模拟弹窗被拦截,dockview 会把 popout 组的面板挪回 gridReferenceGroup。
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dock = createDock();
    vi.useFakeTimers();
    try {
      expect(() => dock.fromJSON(stripped!)).not.toThrow();
      expect(dock.getPanel('1')).toBeDefined();
      expect(dock.getGroupPanel('term-1')).toBeUndefined();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    await dock.popoutRestorationPromise;
    await Promise.resolve();
    expect(dock.getGroupPanel('editor')?.group.id).toBe('1');
  });

  it('floating:grid 剪空后 editor 仍在浮动组中恢复', () => {
    const saved = {
      ...savedWithPopout,
      popoutGroups: undefined,
      floatingGroups: [
        {
          data: { id: '2', views: ['editor'], activeView: 'editor' },
          position: { top: 10, left: 10, width: 400, height: 300 },
        },
      ],
    } as unknown as SerializedDockview;
    const stripped = stripTerminalPanelsFromLayout(saved);
    expect(stripped).not.toBeNull();
    const dock = createDock();
    expect(() => dock.fromJSON(stripped!)).not.toThrow();
    const editor = dock.getGroupPanel('editor');
    expect(editor?.group.api.location.type).toBe('floating');
    expect(dock.getGroupPanel('term-1')).toBeUndefined();
  });
});
