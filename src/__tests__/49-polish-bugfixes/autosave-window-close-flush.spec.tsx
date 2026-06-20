// @vitest-environment jsdom
// topic 49 第十三轮 · P1-AE:关窗 / 退出时 flush 待执行的 markdown autosave。
//
// 根因:关窗走 main→renderer 的 flush 握手(layout:flush-request → DockShell 写盘 →
// sendFlushAck → win.close())。DockShell 的 onFlushRequest 只 flush 了 dockview layout
// 与 flushExplorerPersistence()(会话元数据=打开的 tab/树展开),**漏了** pending 的
// markdown autosave 内容 —— 它卡在 useAutoSave 内部 scheduler 的 2s 防抖 timer 里,
// 只在 React unmount cleanup 才 flush。而 win.close() 销毁 renderer 时 React cleanup
// 不保证执行(同第五轮 watcherPool 前提)。编辑 md 后 2s 内关窗/退出 → 最后一段静默丢失,
// editor content 不持久化,重开即没。第七轮 P1-S 只解决"切 tab/卸载",关窗是另一条路径。
//
// 修复:autosave scheduler 把"立即 flush"句柄注册进模块级 registry(镜像
// explorer-persist 的 activeFlush 模式);DockShell 关窗 flush 握手在 ack 前
// await flushPendingAutoSave(),把 pending 内容纳入 ack 之前的落盘序列。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import {
  flushPendingAutoSave,
  registerAutoSaveFlush,
} from '../../panels/Editor/autosave-flush-registry';
import { makeAutoSaveScheduler } from '../../panels/Editor/auto-save';
import { useEditorStore } from '../../stores/editor.store';

function Probe({
  saveTab,
  delayMs,
}: {
  saveTab: (tabId: string) => Promise<unknown>;
  delayMs: number;
}) {
  useAutoSave(saveTab, { enabled: true, delayMs });
  return null;
}

beforeEach(() => {
  registerAutoSaveFlush(null);
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  cleanup();
  registerAutoSaveFlush(null);
});

describe('topic49 P1-AE · 关窗/退出 flush pending markdown autosave', () => {
  it('scheduler.flush() 返回可 await 的 Promise,resolve 在保存完成之后', async () => {
    let resolved = false;
    const saveFile = vi.fn(
      () =>
        new Promise<void>((r) => {
          setTimeout(() => {
            resolved = true;
            r();
          }, 0);
        }),
    );
    const scheduler = makeAutoSaveScheduler(saveFile, 2000);
    scheduler.schedule();
    await scheduler.flush();
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(true);
  });

  it('无 pending 时 flush() 仍返回已 resolve 的 Promise(no-op)', async () => {
    const saveFile = vi.fn(async () => {});
    const scheduler = makeAutoSaveScheduler(saveFile, 2000);
    await scheduler.flush();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('flushPendingAutoSave() 触发当前活跃 tab 的 pending 落盘(关窗路径)', async () => {
    vi.useFakeTimers();
    try {
      const saveTab = vi.fn(async () => true);
      useEditorStore.setState({
        tabs: [
          { id: '/a.md', filePath: '/a.md', content: 'a-new', originalContent: 'a-old', dirty: true },
        ],
        activeTabId: '/a.md',
      });
      render(<Probe saveTab={saveTab} delayMs={2000} />);
      // 还在防抖窗口内,保存未触发
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(saveTab).not.toHaveBeenCalled();

      // 模拟关窗 flush 握手:在 ack 之前调 flushPendingAutoSave()
      await act(async () => {
        await flushPendingAutoSave();
      });
      expect(saveTab).toHaveBeenCalledWith('/a.md');
      expect(saveTab).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载后 registry 清空 → flushPendingAutoSave() no-op,不重复保存', async () => {
    const saveTab = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'a-new', originalContent: 'a-old', dirty: true },
      ],
      activeTabId: '/a.md',
    });
    const { unmount } = render(<Probe saveTab={saveTab} delayMs={2000} />);
    // 卸载:unmount cleanup 自己会 flush 一次(切走/卸载语义),清空 registry
    await act(async () => {
      unmount();
    });
    saveTab.mockClear();
    // 关窗握手此时再调 → registry 已空,no-op,不会二次保存
    await act(async () => {
      await flushPendingAutoSave();
    });
    expect(saveTab).not.toHaveBeenCalled();
  });
});
