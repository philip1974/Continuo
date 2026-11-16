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
      | ((p?: {
          windowId: number;
          save?: boolean;
          discard?: boolean;
          requestId?: number;
        }) => Promise<void>)
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
        cb: (p?: {
          windowId: number;
          save?: boolean;
          discard?: boolean;
          requestId?: number;
        }) => Promise<void>,
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
import { flushPendingAutoSave } from '@/panels/Editor/autosave-flush-registry';
import { flushExplorerPersistence } from '@/lib/persist/explorer-persist';
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
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: true,
      remaining: { dirty: 1, untitled: 0 },
    });
  });

  it('「不保存」(discard:true)→ 不保存、不做最终脏检查,回执形态不变', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, discard: true });
    });

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.sendFlushAck).toHaveBeenCalledWith(1);
  });

  it('不带 save、无脏 tab → 回执形态不变', async () => {
    await mountShell();

    await act(async () => {
      await h.flushCb.current!({ windowId: 1 });
    });
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
      await h.flushCb.current!({ windowId: 1, discard: true, requestId: 8 });
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
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: true,
      remaining: { dirty: 1, untitled: 0 },
    });
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
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: true,
      remaining: { dirty: 1, untitled: 0 },
    });
  });
});

// 统一规则:所有 flush 完成后、ACK 前做最终脏检查;本轮未选「不保存」且仍有未保存改动 → 回执 remaining,
// main 中止关闭 / 退出(用户再次关闭时会因脏计数看到确认框)。
describe('flush 握手的最终脏检查', () => {
  it('(a) 防抖内关窗(未弹框),autosave flush 首次失败 → 脏 .md 仍脏 → 回执 remaining', async () => {
    await mountShell();
    openDirty('/w/a.md');
    // 防抖内:计数排除 .md,main 无脏记账、不弹框,发来的是不带 save / discard 的 flush。
    // flush 时 autosave 写盘失败(ENOSPC / 磁盘冲突):tab 保持 dirty。
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {
      setAutoSaveFailed('/w/a.md', true);
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, requestId: 9 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      remaining: { dirty: 1, untitled: 0 },
      requestId: 9,
    });
  });

  it('(b) 选「保存」,批量保存成功后 layout/explorer flush 较慢期间继续输入 → 回执 remaining', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    vi.mocked(flushExplorerPersistence).mockImplementationOnce(async () => {
      useEditorStore.getState().updateContent('/w/a.ts', 'typed during flush');
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true, requestId: 10 });
    });
    expect(h.writeFile).toHaveBeenCalledWith('/w/a.ts', 'new');
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      saveFailed: false,
      remaining: { dirty: 1, untitled: 0 },
      requestId: 10,
    });
  });

  it('(c) 多窗退出:本窗初始干净(非保存 flush),确认期间改了代码文件 → 回执 remaining', async () => {
    await mountShell();
    openDirty('/w/b.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, requestId: 11 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      remaining: { dirty: 1, untitled: 0 },
      requestId: 11,
    });
  });

  it('autosave flush 成功落盘 → 不带 remaining(正常关闭)', async () => {
    await mountShell();
    openDirty('/w/a.md');
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {
      useEditorStore.getState().markSaved('/w/a.md');
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, requestId: 12 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { requestId: 12 });
  });
});
