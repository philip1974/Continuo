// 语言服务进程的消息循环(与进程入口 ts-language-server 分开,便于单测):按序处理 main 的消息;definition / warmup 进队列,
// 下一轮事件循环再算 —— 期间到达的 cancel(以及更新的 sync)先被处理,已取消的排队请求不再计算。
// 未保存文档的 sync 立即生效(其后的请求都按新内容算)。

import { createTsLanguageCore, type TsLanguageCore } from './ts-language-core';
import type { TsServerRequest, TsServerResponse } from './ts-server-protocol';

type Job =
  | { readonly kind: 'warmup'; readonly path: string }
  | { readonly kind: 'definition'; readonly id: number; readonly path: string; readonly line: number; readonly column: number };

export interface TsServerLoop {
  handle(msg: TsServerRequest): void;
}

export function createTsServerLoop(
  post: (msg: TsServerResponse) => void,
  createCore: (root: string) => TsLanguageCore = (root) => createTsLanguageCore({ root }),
  schedule: (fn: () => void) => void = (fn) => setImmediate(fn),
): TsServerLoop {
  let core: TsLanguageCore | null = null;
  const queue: Job[] = [];
  const cancelled = new Set<number>();
  let scheduled = false;

  const drain = (): void => {
    scheduled = false;
    const job = queue.shift();
    if (!job) return;
    if (queue.length > 0) kick();
    if (job.kind === 'warmup') {
      try {
        core?.warmup(job.path);
      } catch {
        // 预热失败不影响后续请求
      }
      return;
    }
    if (cancelled.delete(job.id)) {
      post({ type: 'cancelled', id: job.id });
      return;
    }
    if (!core) {
      post({ type: 'error', id: job.id, message: 'not initialized' });
      return;
    }
    try {
      const r = core.definition(job.path, job.line, job.column);
      post({ type: 'result', id: job.id, origin: r.origin, definitions: r.definitions });
    } catch (err) {
      post({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const kick = (): void => {
    if (scheduled) return;
    scheduled = true;
    schedule(drain);
  };

  return {
    handle(msg) {
      switch (msg.type) {
        case 'init':
          core?.dispose();
          core = createCore(msg.root);
          return;
        case 'sync':
          core?.applyChanges(msg.changes);
          return;
        case 'warmup':
          queue.push({ kind: 'warmup', path: msg.path });
          kick();
          return;
        case 'definition':
          queue.push({ kind: 'definition', id: msg.id, path: msg.path, line: msg.line, column: msg.column });
          kick();
          return;
        case 'cancel':
          if (queue.some((j) => j.kind === 'definition' && j.id === msg.id)) cancelled.add(msg.id);
          return;
      }
    },
  };
}
