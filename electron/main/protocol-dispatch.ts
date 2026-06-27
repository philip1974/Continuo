// race(R39/R40):co:// 深链分发到 renderer 的「先就绪后发送 + FIFO 缓冲」路由(main 侧)。
//
// R39:此前 dispatchProtocolUrl 只在「一个窗口都没有」时缓冲,否则无脑 webContents.send 给所有
// 未销毁窗口。但窗口**已创建却还在 loading**(renderer 未 did-finish-load、preload 的 onProtocolUrl
// 还没挂 ipcRenderer.on)时,send 投给没有 listener 的 renderer → 丢失。改为只投「已就绪
// (!isLoading())」窗口;无就绪窗口时缓冲 + did-finish-load 后 drain。
//
// R40:缓冲此前是单槽 string|null,无就绪窗口期间连续到达的多个 co:// 会互相覆盖(last-write-wins)
// → 先到的深链永久丢失。改为 FIFO 队列(string[]):无就绪窗口时 append,窗口就绪后一次性 drain
// 整个队列并清空,保 FIFO 不丢并发深链。

export interface ProtoWindowContents {
  isLoading(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'did-finish-load', cb: () => void): void;
}

export interface ProtoWindow {
  isDestroyed(): boolean;
  readonly webContents: ProtoWindowContents;
}

/** 把缓冲队列(FIFO)一次性排空发到目标 wc;就地清空 pending(成功投递才 shift)。 */
export function drainPendingProtocolUrls(
  wc: ProtoWindowContents,
  channel: string,
  pending: string[],
): void {
  // race(R63):peek 队首、send 成功才 shift。此前 shift 在 send 之前,若 wc 在调用方
  // isDestroyed()/isLoading() 检查后、实际 send 前销毁(窗口关闭竞态),send 抛
  // ("Object has been destroyed")则该 URL 已出队且不会重投 → co:// 深链永久丢失;且抛错
  // 会中断 while 循环,使后续 pending 也停发。改为成功投递才出队;send 抛错时保留队首 URL 在
  // pending(留给下一个就绪/新建窗口 drain),并停止向这个已死 wc 继续投递(不再抛给调用方,
  // 否则 did-finish-load 回调里抛错变 Electron 未捕获异常)。send-fail-abort 同族(见 R62)。
  while (pending.length > 0) {
    const url = pending[0]!;
    try {
      wc.send(channel, { url });
    } catch {
      return; // wc 已销毁:保留 url 在队列,停止本次 drain。
    }
    pending.shift();
  }
}

/**
 * race(R41):给一个新建窗口挂一次性 did-finish-load drain —— 窗口就绪后排空协议队列。
 * 每个 createMainWindow 都调用,使「应用无窗口时入队的 co://」由下一个创建的任意窗口消费,
 * 而非只挂在 bootstrap 窗口上。drain 幂等(队列空即 no-op),多窗口/与 routeProtocolUrl 的
 * loading-窗口 drain 重叠也安全。窗口已销毁则不发。
 */
export function attachWindowDrain(
  win: ProtoWindow,
  channel: string,
  pending: string[],
): void {
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) {
      drainPendingProtocolUrls(win.webContents, channel, pending);
    }
  });
}

export interface RouteProtocolUrlDeps {
  windows: readonly ProtoWindow[];
  channel: string;
  /** 共享的 FIFO 缓冲队列(就地 mutate)。 */
  pending: string[];
}

// 边界(E55):co:// 深链是外部输入(恶意网页/命令行可触发)。单 URL 长度上限 + pending 队列条数
// 上限。co:// 深链短(co://command/<id>?...),8KB 远超真实;无就绪窗口期间 pending 是短暂缓冲,
// >100 条连发 = 滥用。超限丢弃 + 短日志(不抛,不阻塞合法深链)。
export const MAX_PROTOCOL_URL_LEN = 8192;
export const MAX_PENDING_PROTOCOL_URLS = 100;

export function routeProtocolUrl(url: string, deps: RouteProtocolUrlDeps): void {
  const { channel, pending } = deps;
  // 边界(E55):超长/非法 URL 丢弃,绝不入队/IPC/解析(防 main 内存 + renderer 解析放大)。
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_PROTOCOL_URL_LEN) {
    console.warn(
      `[protocol] dropping invalid/oversize co:// url (len=${typeof url === 'string' ? url.length : 'n/a'})`,
    );
    return;
  }
  const ready: ProtoWindow[] = [];
  const loading: ProtoWindow[] = [];
  for (const w of deps.windows) {
    if (w.isDestroyed()) continue;
    if (w.webContents.isLoading()) loading.push(w);
    else ready.push(w);
  }
  if (ready.length === 0) {
    // 边界(E55):pending 队列条数上限 —— 窗口加载期间连发大量深链不得无界占用 main 内存。
    if (pending.length >= MAX_PENDING_PROTOCOL_URLS) {
      console.warn(
        `[protocol] pending queue full (${MAX_PENDING_PROTOCOL_URLS}), dropping co:// url`,
      );
      return;
    }
    // 无就绪窗口:FIFO 入队(不覆盖先到的),并给当前所有 loading 窗口挂一次性 did-finish-load
    // drain。第一个就绪的窗口排空整个队列;其余 drain 见空队列即 no-op(避免重复投递)。
    pending.push(url);
    for (const w of loading) {
      w.webContents.once('did-finish-load', () => {
        if (!w.isDestroyed()) drainPendingProtocolUrls(w.webContents, channel, pending);
      });
    }
    return;
  }
  // 有就绪窗口:先把队列里残留(若有)按 FIFO 排空到一个就绪窗口,再投本次 url(保留既有
  // 「广播到所有就绪窗口」语义)。
  drainPendingProtocolUrls(ready[0]!.webContents, channel, pending);
  // race(R63 同族):逐窗口 try/catch。某个就绪窗口在 ready 过滤后、send 前销毁时 send 会抛,
  // 不捕获则中断循环 → 其余就绪窗口漏投本次 url。每个独立 try/catch 使一个已死窗口不拖累其它。
  let delivered = false;
  for (const w of ready) {
    try {
      w.webContents.send(channel, { url });
      delivered = true;
    } catch {
      // 该窗口已销毁:跳过,继续投其它就绪窗口。
    }
  }
  if (!delivered) {
    // 所有就绪窗口都在 send 时销毁(极端竞态):入队,留给下一个 attachWindowDrain/
    // did-finish-load 的窗口消费,避免本次深链彻底丢失。边界(E55):同样受队列上限约束。
    if (pending.length < MAX_PENDING_PROTOCOL_URLS) pending.push(url);
  }
}
