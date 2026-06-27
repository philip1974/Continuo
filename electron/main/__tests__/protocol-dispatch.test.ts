// race(R39/R40):co:// 深链分发只投就绪窗口(R39),且无就绪窗口期间用 FIFO 队列缓冲多个深链
// (R40,防单槽 last-write-wins 丢掉先到的)。
import { describe, it, expect, vi } from 'vitest';
import {
  routeProtocolUrl,
  drainPendingProtocolUrls,
  attachWindowDrain,
  MAX_PROTOCOL_URL_LEN,
  MAX_PENDING_PROTOCOL_URLS,
  type ProtoWindow,
} from '../protocol-dispatch';

const CH = 'plugins:protocol-url';

function makeWin(opts: { loading: boolean; destroyed?: boolean }): ProtoWindow & {
  send: ReturnType<typeof vi.fn>;
  fireLoaded: () => void;
} {
  let loadedCb: (() => void) | null = null;
  const send = vi.fn();
  return {
    isDestroyed: () => opts.destroyed === true,
    webContents: {
      isLoading: () => opts.loading,
      send,
      once: (_e: 'did-finish-load', cb: () => void) => {
        loadedCb = cb;
      },
    },
    send,
    fireLoaded: () => loadedCb?.(),
  };
}

describe('race(R39) · routeProtocolUrl 先就绪后发送', () => {
  it('就绪窗口 → 立即 send', () => {
    const w = makeWin({ loading: false });
    const pending: string[] = [];
    routeProtocolUrl('co://run/x', { windows: [w], channel: CH, pending });
    expect(w.send).toHaveBeenCalledWith(CH, { url: 'co://run/x' });
    expect(pending).toEqual([]);
  });

  it('窗口存在但 loading(未就绪)→ 不立即 send,入队 + did-finish-load 后 drain', () => {
    const w = makeWin({ loading: true });
    const pending: string[] = [];
    routeProtocolUrl('co://run/y', { windows: [w], channel: CH, pending });
    expect(w.send).not.toHaveBeenCalled();
    expect(pending).toEqual(['co://run/y']);

    w.fireLoaded();
    expect(w.send).toHaveBeenCalledWith(CH, { url: 'co://run/y' });
    expect(pending).toEqual([]);
  });

  it('无窗口(冷启动)→ 仅入队(由 createMainWindow drain 兜底)', () => {
    const pending: string[] = [];
    routeProtocolUrl('co://run/z', { windows: [], channel: CH, pending });
    expect(pending).toEqual(['co://run/z']);
  });

  it('混合:就绪窗口收到,loading 窗口被忽略', () => {
    const ready = makeWin({ loading: false });
    const loadingWin = makeWin({ loading: true });
    const pending: string[] = [];
    routeProtocolUrl('co://run/m', {
      windows: [loadingWin, ready],
      channel: CH,
      pending,
    });
    expect(ready.send).toHaveBeenCalledWith(CH, { url: 'co://run/m' });
    expect(loadingWin.send).not.toHaveBeenCalled();
    expect(pending).toEqual([]);
  });

  it('已销毁窗口不计入就绪也不收 send', () => {
    const dead = makeWin({ loading: false, destroyed: true });
    const pending: string[] = [];
    routeProtocolUrl('co://run/k', { windows: [dead], channel: CH, pending });
    expect(dead.send).not.toHaveBeenCalled();
    expect(pending).toEqual(['co://run/k']);
  });
});

describe('race(R40) · 多深链 FIFO 缓冲不丢', () => {
  it('无就绪窗口期间连续两个 co:// → 都入队,就绪后按序 drain(不 last-write-wins)', () => {
    const w = makeWin({ loading: true });
    const pending: string[] = [];
    routeProtocolUrl('co://run/first', { windows: [w], channel: CH, pending });
    routeProtocolUrl('co://run/second', { windows: [w], channel: CH, pending });
    expect(pending).toEqual(['co://run/first', 'co://run/second']);

    w.fireLoaded();
    expect(w.send).toHaveBeenNthCalledWith(1, CH, { url: 'co://run/first' });
    expect(w.send).toHaveBeenNthCalledWith(2, CH, { url: 'co://run/second' });
    expect(pending).toEqual([]);
  });

  it('两个 loading 窗口:第一个就绪排空队列,第二个就绪见空队列 no-op(不重复)', () => {
    const a = makeWin({ loading: true });
    const b = makeWin({ loading: true });
    const pending: string[] = [];
    routeProtocolUrl('co://run/q', { windows: [a, b], channel: CH, pending });
    expect(pending).toEqual(['co://run/q']);

    a.fireLoaded();
    expect(a.send).toHaveBeenCalledWith(CH, { url: 'co://run/q' });
    expect(pending).toEqual([]);

    b.fireLoaded(); // 队列已空 → 不重复投递
    expect(b.send).not.toHaveBeenCalled();
  });

  it('有就绪窗口时也先排空残留队列再发本次(FIFO 不丢)', () => {
    const pending: string[] = ['co://run/buffered'];
    const ready = makeWin({ loading: false });
    routeProtocolUrl('co://run/live', { windows: [ready], channel: CH, pending });
    // 先 drain 残留,再发 live。
    expect(ready.send).toHaveBeenNthCalledWith(1, CH, { url: 'co://run/buffered' });
    expect(ready.send).toHaveBeenNthCalledWith(2, CH, { url: 'co://run/live' });
    expect(pending).toEqual([]);
  });

  // race(R41):每个新窗口(createMainWindow)都挂 drain,使应用无窗口时入队的深链由下一个创建的
  // 窗口消费(此前只挂 bootstrap 窗口)。
  it('attachWindowDrain:窗口 did-finish-load 后排空队列', () => {
    const w = makeWin({ loading: true });
    const pending = ['co://x', 'co://y'];
    attachWindowDrain(w, CH, pending);
    expect(w.send).not.toHaveBeenCalled(); // 未就绪前不发
    w.fireLoaded();
    expect(w.send.mock.calls.map((c) => c[1])).toEqual([
      { url: 'co://x' },
      { url: 'co://y' },
    ]);
    expect(pending).toEqual([]);
  });

  it('attachWindowDrain:窗口就绪时已销毁 → 不发', () => {
    const w = makeWin({ loading: true, destroyed: true });
    const pending = ['co://x'];
    attachWindowDrain(w, CH, pending);
    w.fireLoaded();
    expect(w.send).not.toHaveBeenCalled();
    expect(pending).toEqual(['co://x']); // 未消费,留给下一个窗口
  });

  it('attachWindowDrain:就绪时队列为空 → no-op(幂等,多窗口重叠安全)', () => {
    const w = makeWin({ loading: true });
    const pending: string[] = [];
    attachWindowDrain(w, CH, pending);
    w.fireLoaded();
    expect(w.send).not.toHaveBeenCalled();
  });

  // race(R63):drain 先 shift 再 send,wc 在销毁竞态中 send 抛错时 URL 已出队且不重投 → 永久
  // 丢失;且抛错中断后续 drain。改为成功投递才出队,抛错保留队首 + 停止本次 drain。
  it('R63 · drain 时 wc.send 抛错 → 队首 URL 不丢、停止 drain、可由后续窗口消费', () => {
    const deadWc = {
      isLoading: () => false,
      send: vi.fn(() => {
        throw new Error('Object has been destroyed');
      }),
      once: () => {},
    };
    const pending = ['co://a', 'co://b'];
    // 不抛给调用方(否则 did-finish-load 回调内变 Electron 未捕获异常)。
    expect(() =>
      drainPendingProtocolUrls(deadWc, CH, pending),
    ).not.toThrow();
    // 队列原封不动(成功投递才 shift)。
    expect(pending).toEqual(['co://a', 'co://b']);

    // 换一个就绪窗口可完整消费,FIFO 不丢。
    const live = makeWin({ loading: false });
    drainPendingProtocolUrls(live.webContents, CH, pending);
    expect(live.send.mock.calls.map((c) => c[1])).toEqual([
      { url: 'co://a' },
      { url: 'co://b' },
    ]);
    expect(pending).toEqual([]);
  });

  // race(R63 同族):广播给多个就绪窗口时,某窗口 send 抛错不应中断其余窗口投递。
  it('R63 · 广播中一个就绪窗口 send 抛错 → 其余就绪窗口仍收到', () => {
    const deadOnSend = makeWin({ loading: false });
    deadOnSend.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const healthy = makeWin({ loading: false });
    const pending: string[] = [];
    routeProtocolUrl('co://run/b', {
      windows: [deadOnSend, healthy],
      channel: CH,
      pending,
    });
    expect(healthy.send).toHaveBeenCalledWith(CH, { url: 'co://run/b' });
    expect(pending).toEqual([]); // 至少一个投递成功 → 不回退入队
  });

  it('R63 · 所有就绪窗口 send 都抛错 → 回退入队留给后续窗口', () => {
    const dead1 = makeWin({ loading: false });
    const dead2 = makeWin({ loading: false });
    for (const w of [dead1, dead2]) {
      w.send.mockImplementation(() => {
        throw new Error('Object has been destroyed');
      });
    }
    const pending: string[] = [];
    routeProtocolUrl('co://run/c', {
      windows: [dead1, dead2],
      channel: CH,
      pending,
    });
    expect(pending).toEqual(['co://run/c']); // 全失败 → 不丢,入队
  });

  it('drainPendingProtocolUrls 一次性排空整个队列并清空', () => {
    const w = makeWin({ loading: false });
    const pending = ['co://a', 'co://b', 'co://c'];
    drainPendingProtocolUrls(w.webContents, CH, pending);
    expect(w.send).toHaveBeenCalledTimes(3);
    expect(w.send.mock.calls.map((c) => c[1])).toEqual([
      { url: 'co://a' },
      { url: 'co://b' },
      { url: 'co://c' },
    ]);
    expect(pending).toEqual([]);
  });
});

// 边界(E55):co:// 深链外部输入面 —— 单 URL 长度上限 + pending 队列条数上限,防恶意网页/命令行
// 连发超长/海量深链无界占用 main 内存 + 后续 IPC/renderer 解析放大。
describe('E55 · co:// 深链长度/队列上限', () => {
  it('超长 URL → 丢弃,不入队不 send', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = makeWin({ loading: false });
    const pending: string[] = [];
    routeProtocolUrl('co://run/' + 'x'.repeat(MAX_PROTOCOL_URL_LEN), {
      windows: [w],
      channel: CH,
      pending,
    });
    expect(w.send).not.toHaveBeenCalled();
    expect(pending).toEqual([]);
    warn.mockRestore();
  });

  it('pending 队列满(无就绪窗口连发)→ 超出丢弃', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadingWin = makeWin({ loading: true });
    const pending: string[] = [];
    for (let i = 0; i < MAX_PENDING_PROTOCOL_URLS + 10; i++) {
      routeProtocolUrl(`co://run/${i}`, {
        windows: [loadingWin],
        channel: CH,
        pending,
      });
    }
    expect(pending).toHaveLength(MAX_PENDING_PROTOCOL_URLS); // 上限封顶,不无界增长
    warn.mockRestore();
  });

  it('上限内正常深链 → 正常入队/send', () => {
    const w = makeWin({ loading: false });
    const pending: string[] = [];
    routeProtocolUrl('co://run/ok', { windows: [w], channel: CH, pending });
    expect(w.send).toHaveBeenCalledWith(CH, { url: 'co://run/ok' });
  });
});
