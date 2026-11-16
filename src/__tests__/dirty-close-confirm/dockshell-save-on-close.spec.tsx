// @vitest-environment jsdom
// 关窗 / 退出时脏文件确认:DockShell 上报脏态 + flush 握手里的「保存」分支。
// dockview / co-api mock 骨架参照 dock-layout-restore-feedback/layout-restore-feedback.spec.tsx。见同目录 README.md。
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  writeFile: vi.fn(),
  reportDirtyState: vi.fn(),
  sendFlushAck: vi.fn(),
  notifyError: vi.fn(),
  flushCb: { current: null as ((p?: { windowId: number; save?: boolean }) => Promise<void>) | null },
}));

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => void }) => {
    const api = React.useMemo(() => {
      const disposable = vi.fn(() => ({ dispose: () => {} }));
      return {
        totalPanels: 1,
        fromJSON: vi.fn(),
        toJSON: vi.fn(() => ({ panels: {} })),
        getPanel: vi.fn(() => null),
        addPanel: vi.fn(() => ({ api: { setActive: vi.fn() } })),
        onDidLayoutChange: disposable,
        onDidRemovePanel: disposable,
        onDidAddPanel: disposable,
        onDidMaximizedGroupChange: disposable,
        panels: [],
      };
    }, []);
    React.useEffect(() => {
      onReady({ api });
    }, [api, onReady]);
    return React.createElement('div', { 'data-testid': 'dockview' });
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    layout: {
      read: vi.fn().mockResolvedValue({ ok: true, data: null }),
      write: vi.fn().mockResolvedValue({ ok: true }),
      onFlushRequest: (cb: (p?: { windowId: number; save?: boolean }) => Promise<void>) => {
        h.flushCb.current = cb;
        return () => {};
      },
      sendFlushAck: h.sendFlushAck,
      reportDirtyState: h.reportDirtyState,
    },
    fs: { readFile: vi.fn(), writeFile: h.writeFile },
    terminal: { remove: vi.fn().mockResolvedValue({ ok: true }) },
    system: { windowId: 1 },
  },
}));
vi.mock('@/notifications/notify', () => ({
  notify: { error: h.notifyError, warn: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/persist/explorer-persist', () => ({
  flushExplorerPersistence: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/panels/Editor/autosave-flush-registry', () => ({
  flushPendingAutoSave: vi.fn().mockResolvedValue(undefined),
}));

import { DockShell } from '@/shell/dock/DockShell';
import { createTab, useEditorStore } from '@/stores/editor.store';

beforeEach(() => {
  h.writeFile.mockReset();
  h.writeFile.mockResolvedValue({ ok: true, data: undefined });
  h.reportDirtyState.mockReset();
  h.sendFlushAck.mockReset();
  h.notifyError.mockReset();
  h.flushCb.current = null;
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

function openDirty(path: string): void {
  act(() => {
    useEditorStore.getState().openTab(createTab(path, 'old'));
    useEditorStore.getState().updateContent(path, 'new');
  });
}

async function mountShell(): Promise<void> {
  render(React.createElement(DockShell));
  await vi.waitFor(() => expect(h.flushCb.current).not.toBeNull());
}

describe('DockShell 向 main 上报关窗会丢的脏 tab 计数', () => {
  it('挂载时无脏 tab 不上报;脏代码文件出现 → 上报;保存后回到 0 → 再上报', async () => {
    await mountShell();
    expect(h.reportDirtyState).not.toHaveBeenCalled();

    openDirty('/w/a.ts');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({ dirty: 1, untitled: 0 }),
    );

    act(() => useEditorStore.getState().markSaved('/w/a.ts'));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({ dirty: 0, untitled: 0 }),
    );
  });
});

describe('flush 握手的「保存」分支', () => {
  it('save:true → 先保存脏 tab,再回执 saveFailed:false', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true });
    });

    expect(h.writeFile).toHaveBeenCalledWith('/w/a.ts', 'new');
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { saveFailed: false });
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false);
  });

  it('保存失败 → toast + 回执 saveFailed:true', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    h.writeFile.mockResolvedValue({ ok: false, code: 'FS_EACCES', message: 'denied' });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true });
    });

    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { saveFailed: true });
  });

  it('不带 save → 不保存,回执形态不变', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1 });
    });

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.sendFlushAck).toHaveBeenCalledWith(1);
  });
});
