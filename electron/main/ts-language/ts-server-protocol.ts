// main ↔ 语言服务进程(utilityProcess)的消息(进程内部协议,不经 renderer)。
// 请求逐个处理;排队期间收到的 cancel 让排队中的请求直接以 cancelled 结束(服务进程单线程,正在算的请求无法中途打断 ——
// VSCode 为此给 tsserver 开了取消管道,这里只取消排队中的,算完的结果由 main 丢弃)。

import type { TsLocation, TsRange } from '../../shared/ts-language';

export type TsServerRequest =
  | { readonly type: 'init'; readonly root: string }
  | { readonly type: 'sync'; readonly changes: readonly { readonly path: string; readonly text: string | null }[] }
  | { readonly type: 'warmup'; readonly path: string }
  | { readonly type: 'definition'; readonly id: number; readonly path: string; readonly line: number; readonly column: number }
  | { readonly type: 'cancel'; readonly id: number };

export type TsServerResponse =
  | {
      readonly type: 'result';
      readonly id: number;
      readonly origin: TsRange | null;
      readonly definitions: readonly TsLocation[];
    }
  | { readonly type: 'cancelled'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly message: string };
