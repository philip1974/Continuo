// @vitest-environment jsdom
// 关窗 / 退出时脏文件确认:DockShell 上报脏态 + flush 握手里的「保存」分支。
// dockview / co-api mock 骨架参照 dock-layout-restore-feedback/layout-restore-feedback.spec.tsx。见同目录 README.md。
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  reportDirtyState: vi.fn(),
  sendFlushAck: vi.fn(),
  notifyError: vi.fn(),
  flushCb: {
    current: null as
      | ((p?: { windowId: number; save?: boolean; requestId?: number }) => Promise<void>)
      | null,
  },
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
      onFlushRequest: (
        cb: (p?: { windowId: number; save?: boolean; requestId?: number }) => Promise<void>,
      ) => {
        h.flushCb.current = cb;
        return () => {};
      },
      sendFlushAck: h.sendFlushAck,
      reportDirtyState: h.reportDirtyState,
    },
    fs: { readFile: h.readFile, writeFile: h.writeFile },
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
import { setAutoSaveFailed } from '@/panels/Editor/autosave-failures';
import { t } from '@/i18n';

beforeEach(() => {
  h.writeFile.mockReset();
  h.writeFile.mockResolvedValue({ ok: true, data: undefined });
  // 保存前读盘比较:默认磁盘内容 = 打开时内容(未被外部修改)。
  h.readFile.mockReset();
  h.readFile.mockResolvedValue({ ok: true, data: 'old' });
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

  it('脏 .md 默认不计;其 autosave 失败 → 重新上报计入;恢复成功 → 再排除', async () => {
    await mountShell();
    openDirty('/w/a.md');
    expect(h.reportDirtyState).not.toHaveBeenCalled();

    act(() => setAutoSaveFailed('/w/a.md', true));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({ dirty: 1, untitled: 0 }),
    );

    act(() => setAutoSaveFailed('/w/a.md', false));
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

  it('请求带 requestId → 回执原样带回(main 据此丢弃过期请求的 ack)', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true, requestId: 7 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { saveFailed: false, requestId: 7 });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, requestId: 8 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { requestId: 8 });
  });

  it('保存期间继续输入(保存返回 ok 但 tab 仍脏)→ 回执 saveFailed:true', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    h.writeFile.mockImplementation(async () => {
      useEditorStore.getState().updateContent('/w/a.ts', 'newer');
      return { ok: true, data: undefined };
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true });
    });

    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { saveFailed: true });
  });

  it('磁盘已被外部修改(EDITOR_DISK_CHANGED)→ 提示里明确说明冲突,回执 saveFailed:true', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    h.readFile.mockResolvedValue({ ok: true, data: 'theirs' });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true });
    });

    expect(h.writeFile).not.toHaveBeenCalled();
    const text = String(h.notifyError.mock.calls[0]?.[0]);
    expect(text).toContain(t('dialog.unsaved_close.disk_changed_note', { count: 1 }));
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { saveFailed: true });
  });
});
