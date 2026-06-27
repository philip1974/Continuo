// @vitest-environment jsdom
// a11y(A131,A130 同族):Dock 布局恢复失败(layout.read reject/!ok 或 fromJSON throw)须 notify.error
// (用户/SR 知布局被重置为默认),且 read reject 不得中断 onReady(默认布局仍要应用)。
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn().mockResolvedValue({ ok: true }),
  notifyError: vi.fn(),
  layoutChangeCb: { current: null as (() => void) | null },
  // race(R22):注册数 / dispose 数计数,验卸载时「注册的全部被 dispose」。
  regCount: { value: 0 },
  disposeCount: { value: 0 },
}));

// race(R22):返回带计数 dispose 的 disposable;注册即计数。
const fakeDisposable = (onCb?: (cb: (...a: unknown[]) => void) => void) =>
  vi.fn((cb: (...a: unknown[]) => void) => {
    onCb?.(cb);
    h.regCount.value += 1;
    return {
      dispose: () => {
        h.disposeCount.value += 1;
      },
    };
  });

vi.mock('dockview-react', () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: unknown }) => void }) => {
    const api = React.useMemo(
      () => ({
        totalPanels: 1,
        fromJSON: vi.fn(),
        toJSON: vi.fn(() => ({ panels: {} })),
        getPanel: vi.fn(() => null),
        addPanel: vi.fn(() => ({ api: { setActive: vi.fn() } })),
        onDidLayoutChange: fakeDisposable((cb) => {
          h.layoutChangeCb.current = cb as () => void;
        }),
        onDidRemovePanel: fakeDisposable(),
        onDidAddPanel: fakeDisposable(),
        onDidMaximizedGroupChange: fakeDisposable(),
        panels: [],
      }),
      [],
    );
    React.useEffect(() => {
      onReady({ api });
    }, [api, onReady]);
    return React.createElement('div', { 'data-testid': 'dockview' });
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    layout: { read: h.read, write: h.write },
    terminal: { remove: vi.fn().mockResolvedValue({ ok: true }) },
    system: { windowId: 1 },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { DockShell } from '@/shell/dock/DockShell';

beforeEach(() => {
  h.read.mockReset();
  h.notifyError.mockReset();
  h.write.mockReset();
  h.write.mockResolvedValue({ ok: true });
  h.regCount.value = 0;
  h.disposeCount.value = 0;
  h.layoutChangeCb.current = null;
  delete (window as { electron?: unknown }).electron;
});

describe('a11y(A131) — Dock 布局恢复失败须反馈', () => {
  it('layout.read reject → notify.error(且不中断 onReady)', async () => {
    h.read.mockRejectedValue(new Error('ipc down'));
    render(React.createElement(DockShell));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('layout.read {ok:false} → notify.error', async () => {
    h.read.mockResolvedValue({ ok: false, code: 'EIO' });
    render(React.createElement(DockShell));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('首次无持久布局(ok + data=null)→ 不报错(默认布局静默)', async () => {
    h.read.mockResolvedValue({ ok: true, data: null });
    render(React.createElement(DockShell));
    // 给 onReady microtask 链跑完
    await new Promise((r) => setTimeout(r, 0));
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  // 持久布局含 terminal panel 是**预期**情况(关窗时开着终端):sanitize 剥离终端、保留非终端
  // 布局后 fromJSON 成功 → **不**报错(终端导致的 sanitize-drop 不再误判为「恢复失败」)。
  it('持久布局含 terminal panel → 剥离后恢复,不报错', async () => {
    h.read.mockResolvedValue({
      ok: true,
      data: {
        grid: {
          root: {
            type: 'branch',
            data: [
              {
                type: 'leaf',
                data: { views: ['editor', 'term-1'], activeView: 'term-1', id: '1' },
                size: 700,
              },
            ],
            size: 800,
          },
          width: 1400,
          height: 800,
          orientation: 'HORIZONTAL',
        },
        panels: {
          editor: { contentComponent: 'editor' },
          'term-1': { contentComponent: 'terminal' },
        },
      },
    });
    render(React.createElement(DockShell));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  // a11y(A132,A131 同族):自动保存(onDidLayoutChange→debounce)写入失败 {ok:false} → 限流 notify。
  it('自动保存 layout.write {ok:false} → notify.error', async () => {
    h.read.mockResolvedValue({ ok: true, data: null }); // onReady 顺利完成
    h.write.mockResolvedValue({ ok: false, code: 'EIO' });
    render(React.createElement(DockShell));
    await vi.waitFor(() => {
      expect(h.layoutChangeCb.current).not.toBeNull();
    });
    h.notifyError.mockReset(); // 忽略 onReady 阶段(无 write)
    // 触发布局变化 → debounce(300ms)→ writeDockLayoutSnapshot(notifyOnFail=true)
    h.layoutChangeCb.current!();
    await vi.waitFor(
      () => {
        expect(h.notifyError).toHaveBeenCalledTimes(1);
      },
      { timeout: 1500 },
    );
  });

  // race(R42):关窗 layout:flush 回调必须在**执行时**读 apiRef.current,而非 effect 注册时闭包
  // 捕获 api。卸载后 apiRef.current=null(R30),迟到/错挂的 flush 回调应跳过写盘,不用 stale api。
  it('R42 flush 回调在 apiRef.current 为空(卸载后)时跳过 writeDockLayoutSnapshot', async () => {
    let flushCb: ((p?: { windowId: number }) => Promise<void>) | null = null;
    (window as { electron?: unknown }).electron = {
      layout: {
        onFlushRequest: (cb: (p?: { windowId: number }) => Promise<void>) => {
          flushCb = cb;
          return () => {};
        },
        sendFlushAck: vi.fn(),
      },
      system: { windowId: 1 },
    };
    h.read.mockResolvedValue({ ok: true, data: null });
    const view = render(React.createElement(DockShell));
    await vi.waitFor(() => expect(flushCb).not.toBeNull());

    view.unmount(); // apiRef.current → null(R30 卸载置空)
    h.write.mockClear();
    await flushCb!({ windowId: 1 }); // 迟到 flush:旧实现用闭包 stale api 仍写;新实现读 null → 跳过

    expect(h.write).not.toHaveBeenCalled();
  });

  // race(R30):onReady 在 await layout.read() 期间组件卸载 → 迟到 resolve 后本次回调已过期
  // (apiRef.current 被 unmount 置 null),不得再注册 listener / fromJSON / setState。
  it('R30 卸载后迟到的 onReady(layout.read 晚 resolve)不再注册 listener / fromJSON', async () => {
    let resolveRead: (v: unknown) => void = () => {};
    h.read.mockReturnValue(
      new Promise((r) => {
        resolveRead = r;
      }),
    );
    const view = render(React.createElement(DockShell));
    // onReady 已 fire 并 park 在 await layout.read():此刻 onReady 自己的 4 个 onDid* 还没注册。
    // baseline 只含 DockReconcilerMount(setReconcilerApi 同步触发挂载)注册的 listener。
    const baseline = h.regCount.value;

    view.unmount(); // 卸载 → apiRef.current=null 失效迟到 onReady
    resolveRead({ ok: true, data: { panels: { p1: {} } } }); // 迟到 resolve(含可 fromJSON 的数据)
    await new Promise((r) => setTimeout(r, 0));

    // stale guard 生效:过期 onReady 提前返回 → 不再注册它那 4 个 onDid* listener(否则 regCount +4)。
    expect(h.regCount.value).toBe(baseline);
  });

  // race(R22):DockShell 卸载时须 dispose onReady 注册的全部 dockview onDid* listener +
  // cancel layout debounce,否则旧 listener/迟到写盘对新实例生效。
  it('R22 卸载 → dispose 全部 onDid* listener + cancel layout debounce', async () => {
    h.read.mockResolvedValue({ ok: true, data: null });
    h.write.mockResolvedValue({ ok: true });
    const view = render(React.createElement(DockShell));
    await vi.waitFor(() => {
      expect(h.layoutChangeCb.current).not.toBeNull();
    });
    expect(h.disposeCount.value).toBe(0); // 挂载期间不 dispose

    // 触发一次布局变化排定 debounce 写盘(300ms)。
    h.layoutChangeCb.current!();
    h.write.mockClear();

    const registered = h.regCount.value;
    expect(registered).toBeGreaterThanOrEqual(4); // 至少 4 个 onDid* listener 注册

    view.unmount(); // 卸载 → dispose 全部 listener + cancel debounce

    // 注册的 onDid* 全部被 dispose(无残留 listener)。
    expect(h.disposeCount.value).toBe(registered);

    // debounce 被 cancel → 300ms 后不应再写盘(迟到 layout 写不覆盖新实例)。
    await new Promise((r) => setTimeout(r, 400));
    expect(h.write).not.toHaveBeenCalled();
  });
});
