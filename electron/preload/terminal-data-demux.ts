// 性能 P1(codex perf 审计):终端输出热路径的窗口级单订阅分发器。
//
// 旧实现:coApi.terminal.onData(cb) 每次调用都 `ipcRenderer.on('terminal:data', …)`
// 注册一个独立 listener,回调里 `if (id !== termId) return` 自行过滤。main 已按
// session 路由到 owning window,但窗口内挂了 N 个 terminal panel 时,任一高输出
// session 的每个 chunk 都会触发全部 N 个 JS listener,其中 N-1 个只做无效过滤。
// 终端输出是高频热路径(build log / agent CLI / tail -f),开销随终端数线性增长。
//
// 新实现:整个窗口对 'terminal:data' 只挂**一个** ipcRenderer listener,按 sessionId
// 路由到 Map<id, Set<handler>>。每个 chunk 的 renderer 回调开销从 O(N) 降到
// O(该 id 的 handler 数)≈ O(1)。本模块是纯逻辑(不碰 ipcRenderer),便于单测。

export type TerminalDataHandler = (data: string) => void;

export interface TerminalDataDemux {
  /** 为某 sessionId 注册 handler,返回 unsubscribe。 */
  add(id: string, handler: TerminalDataHandler): () => void;
  /**
   * 把一个 chunk 分发给注册在该 id 上的 handler。返回实际被调用的 handler 数
   * —— 关键不变量:只调 id 匹配的,绝不 fan-out 到别的 session 的 handler。
   */
  dispatch(id: string, data: string): number;
  /** 当前被追踪的 sessionId 数(测试/自省用)。 */
  idCount(): number;
}

export function createTerminalDataDemux(): TerminalDataDemux {
  const handlers = new Map<string, Set<TerminalDataHandler>>();
  return {
    add(id, handler) {
      let set = handlers.get(id);
      if (!set) {
        set = new Set();
        handlers.set(id, set);
      }
      set.add(handler);
      return () => {
        const s = handlers.get(id);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) handlers.delete(id);
      };
    },
    dispatch(id, data) {
      const set = handlers.get(id);
      if (!set) return 0;
      // 快照迭代:某 handler 在分发中 unsubscribe(如首 chunk 即拆面板)不影响本轮。
      let n = 0;
      for (const h of [...set]) {
        h(data);
        n++;
      }
      return n;
    },
    idCount() {
      return handlers.size;
    },
  };
}
