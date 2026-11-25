/// <reference types="electron-vite/node" />
// 在文件中查找(workspace-search)的 IPC 接线:search:start / search:cancel 走 safeHandle 管线(frame 信任 + zod),
// 根取自发送窗口;worker 线程经 electron-vite `?nodeWorker` 创建(独立 chunk)。webContents 离开(关闭 / 重载 / 崩溃)→
// 取消其在途搜索。逻辑在 services/text-search.service(可单测),这里只接真实 Electron / worker。
// BDD: src/__tests__/workspace-search/

import createSearchWorker from '../search/text-search.worker?nodeWorker';
import { safeHandleWithCtx, senderWindowOrThrow } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import { SEARCH_CHANNELS } from '../../shared/workspace-search';
import { getWorkspaceRoot } from '../services/window-workspace-roots.service';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import {
  createTextSearchService,
  makeSearchStartHandler,
  searchCancelInputSchema,
  searchStartInputSchema,
} from '../services/text-search.service';

export function registerSearchIpc(): void {
  const service = createTextSearchService((workerData) => createSearchWorker({ workerData }));
  const start = makeSearchStartHandler(service, getWorkspaceRoot);
  const attachGoneHook = makeWcGoneHook((wcId) => service.cancelAll(wcId));

  safeHandleWithCtx(SEARCH_CHANNELS.START, searchStartInputSchema, (input, { event }) => {
    const win = senderWindowOrThrow(event, ERROR_CODES.NO_WINDOW);
    attachGoneHook(event.sender);
    start(input, win, event.sender);
  });
  safeHandleWithCtx(SEARCH_CHANNELS.CANCEL, searchCancelInputSchema, (input, { event }) => {
    service.cancel(event.sender.id, input.searchId);
  });
}
