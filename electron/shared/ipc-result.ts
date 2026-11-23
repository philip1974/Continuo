// 全工程 IPC envelope。详见 ADR-010。
// 经 safeHandle 注册的 ipcMain.handle 通道都返回 IpcResult,renderer 端拿到后按 ok 分流
// (plugin-data / plugin-fs / plugin-shell-stream 返回裸值,见 electron/main/README.md)。

export interface IpcOk<T> {
  readonly ok: true;
  readonly data: T;
}

export interface IpcFail {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type IpcResult<T> = IpcOk<T> | IpcFail;

// 基础设施层错误码。业务通道(fs / layout)可定义自己的 code 字符串,
// safeHandle 会原样透传。
export const IPC_ERR = {
  DENIED: 'IPC_DENIED', // safeHandle senderFrame 校验失败
  BAD_INPUT: 'IPC_BAD_INPUT', // zod 校验失败
  HANDLER_ERROR: 'IPC_HANDLER_ERROR', // handler 抛错且未带 code
} as const;
