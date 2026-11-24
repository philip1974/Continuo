// preload 里「订阅 main → renderer 推送,返回 unsubscribe」的唯一写法(此前 16 处手写 on + off /
// removeListener 成对样板)。listener 仍按 Electron 约定收 (event, ...args);各调用点自己决定透传哪些
// 参数给 renderer 回调(不把 IpcRendererEvent 暴露出去)。
//
// 注意:preload 跑在 sandbox,本文件只能依赖 electron 的 ipcRenderer,不得引入 node:* 模块。

import { ipcRenderer, type IpcRendererEvent } from 'electron';

export function subscribeIpc<A extends unknown[]>(
  channel: string,
  listener: (event: IpcRendererEvent, ...args: A) => void,
): () => void {
  // ipcRenderer.on 的 listener 形参是 any[];这里收窄成各通道自己的实参类型。
  const wrapped = listener as (event: IpcRendererEvent, ...args: unknown[]) => void;
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

/**
 * 先挂监听、再告诉 main「本文档已能接收该推送」(readyChannel)。关窗 flush 请求、co:// 深链、agent 授权请求三条
 * 就绪握手共用:顺序反过来,main 在监听挂上前推送的那条会丢。main 侧在文档换掉时作废就绪(见
 * electron/main/lib/renderer-document-gone),新文档重新订阅即重新上报。
 */
export function subscribeAndAnnounce<A extends unknown[]>(
  channel: string,
  readyChannel: string,
  listener: (event: IpcRendererEvent, ...args: A) => void,
): () => void {
  const unsubscribe = subscribeIpc(channel, listener);
  ipcRenderer.send(readyChannel);
  return unsubscribe;
}
