// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 F2:切走 tab 后的在途 autosave flush 必须纳入关窗 ack。
//
// 根因:useAutoSave 在切走某 tab / 卸载时,effect cleanup 会 fire-and-forget 触发旧 tab
// scheduler 的 flush();但 registry 的 activeFlush 已被新 tab 覆盖(或清空),旧 tab 这次
// 在途的落盘不在 activeFlush 里。若此刻立即关窗,flush 握手(DockShell→flushPendingAutoSave)
// 只 await activeFlush → 主进程 ack 后继续退出,旧 tab 最后一段编辑的写盘 IPC 仍在飞 →
// 静默丢失。这是第十三轮 P1-AE(关窗 flush 注册表)的兄弟缺口:registry 只跟踪"当前活跃 tab"。
//
// 修:在途 flush 登记进 trackInFlightAutoSave,flushPendingAutoSave() 一并 await(allSettled)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import {
  flushPendingAutoSave,
  registerAutoSaveFlush,
  trackInFlightAutoSave,
} from '../../panels/Editor/autosave-flush-registry';
import { useEditorStore } from '../../stores/editor.store';

function Probe({ saveTab }: { saveTab: (tabId: string) => Promise<unknown> }) {
  useAutoSave(saveTab, { enabled: true, delayMs: 2000 });
  return null;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  registerAutoSaveFlush(null);
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  cleanup();
  registerAutoSaveFlush(null);
});

describe('topic49 codexF2 · 切 tab 在途 flush 纳入关窗 ack', () => {
  it('trackInFlightAutoSave 登记的在途 flush 被 flushPendingAutoSave() await', async () => {
    const d = deferred();
    trackInFlightAutoSave(d.promise);
    let settled = false;
    const fp = flushPendingAutoSave().then(() => {
      settled = true;
    });
    // 在途未完成 → flushPendingAutoSave 不应 resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    // 在途完成 → flushPendingAutoSave resolve
    d.resolve();
    await fp;
    expect(settled).toBe(true);
  });

  it('settle 后自动移除,不泄漏到下一次 flush', async () => {
    const d = deferred();
    trackInFlightAutoSave(d.promise);
    d.resolve();
    await d.promise;
    await Promise.resolve();
    // 下一次 flush 不再等待已完成的旧 promise(立即 resolve)
    let settled = false;
    await flushPendingAutoSave().then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });

  it('只有一个在途 flush 且无 active flush 时直接 await,不走 allSettled 数组路径', async () => {
    const allSettledSpy = vi.spyOn(Promise, 'allSettled');
    const d = deferred();
    trackInFlightAutoSave(d.promise);

    try {
      let settled = false;
      const fp = flushPendingAutoSave().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(allSettledSpy).not.toHaveBeenCalled();

      d.resolve();
      await fp;
      expect(settled).toBe(true);
      expect(allSettledSpy).not.toHaveBeenCalled();
    } finally {
      allSettledSpy.mockRestore();
    }
  });

  it('编辑 A 后切到 B 再立即关窗:关窗握手 await A 的在途落盘(不丢最后编辑)', async () => {
    const gate = deferred();
    const saveTab = vi.fn((id: string) =>
      id === '/a.md' ? gate.promise.then(() => true) : Promise.resolve(true),
    );
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'a-new', originalContent: 'a-old', dirty: true },
        { id: '/b.md', filePath: '/b.md', content: 'b', originalContent: 'b', dirty: false },
      ],
      activeTabId: '/a.md',
    });
    render(<Probe saveTab={saveTab} />);

    // 切到 B:A 的 effect cleanup fire-and-forget 触发 A 的 flush(在途、被 gate 卡住)。
    await act(async () => {
      useEditorStore.setState({ activeTabId: '/b.md' });
    });
    expect(saveTab).toHaveBeenCalledWith('/a.md');

    // 立即关窗 flush 握手:必须 await A 的在途落盘,否则 A 最后一段丢失。
    let ackReady = false;
    const handshake = flushPendingAutoSave().then(() => {
      ackReady = true;
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // A 的写盘还卡在 gate 上 → ack 不应就绪
    expect(ackReady).toBe(false);

    // A 落盘完成 → ack 就绪
    gate.resolve();
    await act(async () => {
      await handshake;
    });
    expect(ackReady).toBe(true);
  });
});
