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
