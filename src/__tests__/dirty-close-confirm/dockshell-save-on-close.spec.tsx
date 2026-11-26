// @vitest-environment jsdom
// 关窗 / 退出时脏文件确认:DockShell 上报脏态 + flush 握手里的「保存」分支。
// dockview / co-api mock 骨架参照 dock-layout-restore-feedback/layout-restore-feedback.spec.tsx。见同目录 README.md。
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
          pendingAutoSave?: string[];
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
        onDidActiveGroupChange: disposable,
        onDidActivePanelChange: disposable,
        // popout 文档跟踪(trackPopoutDocuments)。
        onDidAddGroup: disposable,
        onDidRemoveGroup: disposable,
        onWillDrop: disposable,
        groups: [],
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
          pendingAutoSave?: string[];
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
import { claimAutoSave, releaseAutoSave, setAutoSaveFailed } from '@/panels/Editor/autosave-failures';
import { flushPendingAutoSave } from '@/panels/Editor/autosave-flush-registry';
import { flushExplorerPersistence } from '@/lib/persist/explorer-persist';
import {
  registerEditorWriteBack,
} from '@/panels/Editor/editor-writeback-registry';
import { applyEditorWriteBack } from '@/panels/Editor/editor-file-actions';
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

// globals:false 下 testing-library 不自动 cleanup:上一用例挂着的 DockShell 会在下一用例 beforeEach 清空 tabs 时补报。
afterEach(() => cleanup());

/** 期望的脏态上报 / remaining / 回执 state(计数由 id 列表推出;id = `${tabId}#${变脏代际}`)。 */
function ds(ids: string[]) {
  return { dirty: ids.length, ids };
}

/** tab 当前的上报身份(变脏代际取自全局单调计数器,只能从 store 读出)。 */
const g = (id: string): string =>
  `${id}#${useEditorStore.getState().tabs.find((x) => x.id === id)?.dirtyGen ?? 0}`;

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


const noopFlush = async (): Promise<void> => {};
describe('DockShell 向 main 上报关窗会丢的脏 tab 计数', () => {
  it('挂载时无脏 tab 不上报;脏代码文件出现 → 上报;保存后回到 0 → 再上报', async () => {
    await mountShell();
    expect(h.reportDirtyState).not.toHaveBeenCalled();

    openDirty('/w/a.ts');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([g('/w/a.ts')])),
    );

    act(() => useEditorStore.getState().markSaved('/w/a.ts'));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([])),
    );
  });

  // 保存期间继续输入:markSaved 推进基线后 tab 仍脏但换了新变脏代际 → 必须带新身份重新上报,
  // 否则 main 的最终检查仍把旧代际视为已获准丢弃而退出,丢失保存期间的输入(终审 P1)。
  it('保存期间继续输入 → markSaved 后以新变脏代际重新上报', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    const oldId = g('/w/a.ts');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([oldId])),
    );

    act(() => {
      useEditorStore.getState().updateContent('/w/a.ts', 'new+typed');
      useEditorStore.getState().markSaved('/w/a.ts', 'new');
    });
    const newId = g('/w/a.ts');
    expect(newId).not.toBe(oldId);
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([newId])),
    );
  });

  // 只有活动 tab(持有 autosave scheduler)的脏 .md 豁免;失败 → 计入;恢复 → 再豁免。
  // 终审 P1:豁免的 .md 仍随上报带 pendingAutoSave(依赖关窗 flush 才能落盘),main 据此在 flush 超时时中止关闭。
  it('活动 tab 的脏 .md 不计但上报为 pendingAutoSave;其 autosave 失败 → 计入;恢复成功 → 再排除', async () => {
    const owner = {};
    act(() => claimAutoSave('/w/a.md', owner, noopFlush));
    await mountShell();
    openDirty('/w/a.md');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({
        ...ds([]),
        pendingAutoSave: [g('/w/a.md')],
      }),
    );

    act(() => setAutoSaveFailed(owner, true));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([g('/w/a.md')])),
    );

    act(() => setAutoSaveFailed(owner, false));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({
        ...ds([]),
        pendingAutoSave: [g('/w/a.md')],
      }),
    );
    // autosave 落盘后 tab 变干净 → pendingAutoSave 清空并重新上报
    act(() => useEditorStore.getState().markSaved('/w/a.md'));
    await vi.waitFor(() => expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([])));
    act(() => releaseAutoSave(owner));
  });

  // 复审:非活动 tab 切走时已 flush,仍脏即失败或在途,关窗 flush 不会重试 → 计入(含重命名后的非活动 tab)。
  it('非活动 tab 的脏 .md 计入;持有者切换时重新上报', async () => {
    const owner = {};
    act(() => claimAutoSave('/w/a.md', owner, noopFlush));
    await mountShell();
    openDirty('/w/b.md');
    openDirty('/w/a.md');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({
        ...ds([g('/w/b.md')]),
        pendingAutoSave: [g('/w/a.md')],
      }),
    );
    act(() => useEditorStore.getState().renamePath('/w/b.md', '/w/c.md'));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith({
        ...ds([g('/w/c.md')]),
        pendingAutoSave: [g('/w/a.md')],
      }),
    );
    act(() => releaseAutoSave(owner));
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([g('/w/c.md'), g('/w/a.md')])),
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
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { saveFailed: false, state: ds([]) });
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false);
  });

  // Milkdown 200ms 防抖内的输入尚未进 store:握手须先同步回写编辑器内容,再保存 / flush autosave。
  it('先同步回写编辑器里未上抛的输入,再保存 / flush autosave', async () => {
    await mountShell();
    act(() => useEditorStore.getState().openTab(createTab('/w/a.ts', 'old')));
    const unregister = registerEditorWriteBack('/w/a.ts', () =>
      applyEditorWriteBack('/w/a.ts', 'typed', 'old'),
    );
    let contentAtAutoSaveFlush: string | undefined;
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {
      contentAtAutoSaveFlush = useEditorStore.getState().tabs[0]?.content;
    });
    try {
      await act(async () => {
        await h.flushCb.current!({ windowId: 1, save: true });
      });
    } finally {
      unregister();
    }

    expect(h.writeFile).toHaveBeenCalledWith('/w/a.ts', 'typed');
    expect(contentAtAutoSaveFlush).toBe('typed');
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
      state: ds([g('/w/a.ts')]),
      remaining: ds([g('/w/a.ts')]),
    });
  });

  it('「不保存」(discard:true)→ 不保存、不做最终脏检查(不带 remaining),回执仍带最终脏态', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, discard: true });
    });

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { state: ds([g('/w/a.ts')]) });
  });

  // 终审 P1:「不保存」只针对确认框列出的文件。确认时未列入框的待 autosave .md(main 随请求带 pendingAutoSave)
  // 在 flush 中保存失败 → 回执 remaining,main 中止关闭;框里列出的文件仍按「不保存」丢弃。
  it('「不保存」+ 待 autosave 的 .md flush 保存失败 → 回执 remaining', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    openDirty('/w/a.md');
    const mdId = g('/w/a.md');
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {});

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, discard: true, pendingAutoSave: [mdId], requestId: 13 });
    });
    const state = useEditorStore.getState().tabs.map((x) => g(x.id));
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      state: ds(state),
      remaining: ds(state),
      requestId: 13,
    });
  });

  it('「不保存」+ 待 autosave 的 .md flush 保存成功 → 不带 remaining(框里的代码文件照常丢弃)', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    openDirty('/w/a.md');
    const mdId = g('/w/a.md');
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {
      useEditorStore.getState().markSaved('/w/a.md');
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, discard: true, pendingAutoSave: [mdId], requestId: 14 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { state: ds([g('/w/a.ts')]), requestId: 14 });
  });

  it('不带 save、无脏 tab → 回执带空的最终脏态', async () => {
    await mountShell();

    await act(async () => {
      await h.flushCb.current!({ windowId: 1 });
    });
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, { state: ds([]) });
  });

  it('请求带 requestId → 回执原样带回(main 据此丢弃过期请求的 ack)', async () => {
    await mountShell();
    openDirty('/w/a.ts');

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true, requestId: 7 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      saveFailed: false,
      state: ds([]),
      requestId: 7,
    });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, discard: true, requestId: 8 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { state: ds([]), requestId: 8 });
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
      state: ds([g('/w/a.ts')]),
      remaining: ds([g('/w/a.ts')]),
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
    // 保存键填当前生效绑定(jsdom = 'other' → Ctrl+S),不写死 Cmd/Ctrl+S
    expect(text).toContain(t('dialog.unsaved_close.disk_changed_note', { count: 1, hotkey: 'Ctrl+S' }));
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: true,
      state: ds([g('/w/a.ts')]),
      remaining: ds([g('/w/a.ts')]),
    });
  });
});

describe('flush 握手「保存」遇只读文件', () => {
  it('FS_READONLY → 提示含文件名与只读出路(保存键 / 不保存),回执 saveFailed:true', async () => {
    await mountShell();
    openDirty('/w/ro.ts');
    h.writeFile.mockResolvedValue({ ok: false, code: 'FS_READONLY', message: 'file is write-protected' });

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, save: true });
    });

    const text = String(h.notifyError.mock.calls[0]?.[0]);
    expect(text).toContain('ro.ts');
    expect(text).toContain(t('dialog.unsaved_close.readonly_note', { count: 1, hotkey: 'Ctrl+S' }));
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: true,
      state: ds([g('/w/ro.ts')]),
      remaining: ds([g('/w/ro.ts')]),
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
    vi.mocked(flushPendingAutoSave).mockImplementationOnce(async () => {});

    await act(async () => {
      await h.flushCb.current!({ windowId: 1, requestId: 9 });
    });
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, {
      state: ds([g('/w/a.md')]),
      remaining: ds([g('/w/a.md')]),
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
      // 保存后变干净、flush 期间再输入 → 第二次变脏
      state: ds([g('/w/a.ts')]),
      remaining: ds([g('/w/a.ts')]),
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
      state: ds([g('/w/b.ts')]),
      remaining: ds([g('/w/b.ts')]),
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
    expect(h.sendFlushAck).toHaveBeenLastCalledWith(1, { state: ds([]), requestId: 12 });
  });
});

// 复审:选「保存」后 saveTab 使 tab 变干净,但此前 remaining 为空时直接发回执,干净状态要等之后的 useEffect 上报
// → main 可能先用旧脏集合做全局最终检查而误中止退出。回执始终携带 flush 后的最终脏态(含空集合),main 以其记账。
// 不经 act() 调用 flush 回调:断言回执 payload 本身,不依赖 effect 被冲刷。
describe('flush 回执携带最终脏态', () => {
  it('「保存」后 tab 变干净 → 回执 state 为空集合(不等 effect 上报)', async () => {
    await mountShell();
    openDirty('/w/a.ts');
    await vi.waitFor(() =>
      expect(h.reportDirtyState).toHaveBeenLastCalledWith(ds([g('/w/a.ts')])),
    );
    h.reportDirtyState.mockClear();

    await h.flushCb.current!({ windowId: 1, save: true, requestId: 15 });
    expect(h.sendFlushAck).toHaveBeenCalledTimes(1);
    expect(h.sendFlushAck).toHaveBeenCalledWith(1, {
      saveFailed: false,
      state: ds([]),
      requestId: 15,
    });
  });
});
