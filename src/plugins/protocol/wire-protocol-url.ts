import type { CoApp } from '../types';

// race(R33):co:// 深链(冷启动唤起)的「先监听后异步加载」接线。
//
// 此前 main-app 把订阅写在 `import('./handler').then(...)` 里 —— onProtocolUrl 要等动态 import
// 的微任务 resolve 才挂 ipcRenderer.on(见 preload onProtocolUrl 同步挂载)。而 main 冷启动在
// did-finish-load 只 send 一次 PROTOCOL_URL 且无 replay/缓冲;若 import 晚于 did-finish-load,
// 事件投到一个还没 listener 的 renderer → 丢失,表现为「点 co:// 链接应用打开却不执行命令」。
//
// 修法(listener-before-async-work,R16 同族):同步注册 onProtocolUrl(立即挂 ipcRenderer.on),
// handler 推迟到回调里 lazy-load —— 监听在初始同步执行阶段就位,早于 did-finish-load,不丢事件;
// handler 仍按需加载(无 url 到达就不拉 chunk)。
export interface WireProtocolUrlDeps {
  /** preload 的 coApi.plugins.onProtocolUrl —— 调用即同步挂 ipcRenderer.on。 */
  onProtocolUrl: (cb: (url: string) => void) => void;
  /** 懒加载 handler 模块(动态 import)。 */
  loadHandler: () => Promise<{
    handleProtocolUrl: (url: string, app: Pick<CoApp, 'commands'>) => unknown;
  }>;
  app: Pick<CoApp, 'commands'>;
  /** 加载/处理失败的可见日志(默认 console.warn)。 */
  onError?: (err: unknown) => void;
}

export function wireProtocolUrl(deps: WireProtocolUrlDeps): void {
  const onError =
    deps.onError ??
    ((err: unknown) => console.warn('[protocol] handle url failed', err));
  // 同步注册:这一步必须在任何 await/import 之前完成,才能赶在冷启动 did-finish-load 之前挂上监听。
  deps.onProtocolUrl((url) => {
    void deps
      .loadHandler()
      .then(({ handleProtocolUrl }) => handleProtocolUrl(url, deps.app))
      .catch(onError);
  });
}
