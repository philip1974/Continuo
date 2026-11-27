// 语言服务进程入口(Electron utilityProcess,由 ipc/ts-language.ipc 经 electron-vite `?modulePath` fork;不在 main 进程里跑 ——
// 加载项目 / 计算定义可能数秒,不占 main 的事件循环)。只处理 main 经 parentPort 发来的消息(见 ts-server-loop);
// 不执行项目代码、不加载 TS 插件,只读文件(范围见 ts-language-core)。
// BDD: src/__tests__/editor-go-to-definition/

import { createTsServerLoop } from './ts-server-loop';
import type { TsServerRequest } from './ts-server-protocol';

interface ParentPortLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
// 只在 utilityProcess 里运行(被当作普通模块加载时 —— 单测 —— 不做任何事)
if (port) {
  const loop = createTsServerLoop((msg) => port.postMessage(msg));
  port.on('message', (e) => loop.handle(e.data as TsServerRequest));
}
