// 在文件中查找的 worker 线程入口(由 ipc/search.ipc.ts 经 electron-vite `?nodeWorker` 创建):跑 runTextSearch,
// 分批结果 / 结束 / 失败经 postMessage 交给主线程的 text-search.service 转发 renderer。取消由主线程 terminate。

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runTextSearch } from './text-search';
import type { SearchQuery } from '../../shared/workspace-search';
import { thrownFields } from '../../shared/error-message';
import { ERROR_CODES } from '../../shared/error-codes';

// 只在 worker 线程里运行:被主线程按普通模块加载(单测经 vitest 解析 `?nodeWorker` import)时不做任何事。
if (!isMainThread && parentPort) {
  const port = parentPort;
  const { root, query } = workerData as { root: string; query: SearchQuery };
  runTextSearch({ root, query, onFiles: (files) => port.postMessage({ kind: 'files', files }) }).then(
    ({ limitHit, filesLimitHit }) => port.postMessage({ kind: 'done', limitHit, filesLimitHit }),
    (err: unknown) => {
      const { code, message } = thrownFields(err);
      port.postMessage({ kind: 'error', code: code ?? ERROR_CODES.SEARCH_FAILED, message: message ?? String(err) });
    },
  );
}
