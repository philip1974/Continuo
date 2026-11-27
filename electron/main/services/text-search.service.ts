// 工作区文本搜索服务(在文件中查找):每个 webContents 至多一个在途搜索,运行在 worker 线程(VSCode 把 ripgrep 放在独立进程)——
// 用户正则的灾难性回溯 / 大工作区读盘匹配都不占主进程事件循环;取消 = 终止 worker(卡在正则里也能停)。
// worker 工厂注入(生产为 electron-vite `?nodeWorker`,见 ipc/search.ipc.ts;单测注入假 worker)。
// BDD: src/__tests__/workspace-search/

import { z } from 'zod';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import { trySend, type SendTarget } from '../lib/try-send';
import {
  buildSearchRegExp,
  SEARCH_CHANNELS,
  SEARCH_GLOB_MAX,
  SEARCH_ID_MAX,
  SEARCH_PATTERN_MAX,
  type SearchQuery,
} from '../../shared/workspace-search';

/** worker 线程的最小形状(node:worker_threads Worker 满足)。 */
export interface SearchWorkerLike {
  on(event: 'message', cb: (message: unknown) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): unknown;
}

export type CreateSearchWorker = (data: { root: string; query: SearchQuery }) => SearchWorkerLike;

/** 结果投递目标(webContents):id 作每窗口单飞键。 */
export interface SearchTarget extends SendTarget {
  readonly id: number;
}

export interface TextSearchService {
  start(target: SearchTarget, searchId: string, query: SearchQuery, root: string): void;
  cancel(targetId: number, searchId: string): void;
  cancelAll(targetId: number): void;
}

export function createTextSearchService(createWorker: CreateSearchWorker): TextSearchService {
  const active = new Map<number, { readonly searchId: string; readonly worker: SearchWorkerLike }>();

  const stop = (targetId: number): void => {
    const cur = active.get(targetId);
    if (!cur) return;
    active.delete(targetId);
    void Promise.resolve(cur.worker.terminate()).catch(() => {});
  };

  return {
    start(target, searchId, query, root) {
      stop(target.id); // 新查询取消旧查询
      const worker = createWorker({ root, query });
      const entry = { searchId, worker };
      active.set(target.id, entry);
      const isCurrent = () => active.get(target.id) === entry;
      // 投递失败(窗口已销毁 / 重载中)→ 没人收了,终止搜索。
      const deliver = (payload: Record<string, unknown>): void => {
        if (!trySend(target, SEARCH_CHANNELS.EVENT, { searchId, ...payload })) stop(target.id);
      };
      worker.on('message', (message) => {
        if (!isCurrent() || typeof message !== 'object' || message === null) return;
        const kind = (message as { kind?: unknown }).kind;
        if (kind === 'done' || kind === 'error') active.delete(target.id);
        deliver(message as Record<string, unknown>);
      });
      worker.on('error', (err) => {
        if (!isCurrent()) return;
        active.delete(target.id);
        deliver({ kind: 'error', code: ERROR_CODES.SEARCH_FAILED, message: err.message });
      });
      worker.on('exit', (code) => {
        if (!isCurrent()) return; // 已正常结束 / 被取消
        active.delete(target.id);
        deliver({ kind: 'error', code: ERROR_CODES.SEARCH_FAILED, message: `search worker exited (${code})` });
      });
    },
    cancel(targetId, searchId) {
      if (active.get(targetId)?.searchId === searchId) stop(targetId);
    },
    cancelAll(targetId) {
      stop(targetId);
    },
  };
}

const searchId = () => z.string().min(1).max(SEARCH_ID_MAX);

export const searchStartInputSchema = z
  .object({
    searchId: searchId(),
    query: z
      .object({
        pattern: z.string().min(1).max(SEARCH_PATTERN_MAX),
        isRegex: z.boolean(),
        matchCase: z.boolean(),
        wholeWord: z.boolean(),
        include: z.string().max(SEARCH_GLOB_MAX),
        exclude: z.string().max(SEARCH_GLOB_MAX),
        disregardIgnoreFiles: z.boolean().optional(),
        disregardExcludeSettings: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const searchCancelInputSchema = z.object({ searchId: searchId() }).strict();

/**
 * search:start:根取自**发送窗口**的工作区根(renderer 不传根,只能搜自己窗口打开的文件夹);无工作区 → BAD_ROOT;
 * 非法正则 → BAD_INPUT(renderer 已先拦,这里兜底,不起 worker)。
 */
export function makeSearchStartHandler(
  service: TextSearchService,
  getRoot: (windowId: number) => string | null,
) {
  return (input: z.infer<typeof searchStartInputSchema>, win: { readonly id: number }, target: SearchTarget): void => {
    const root = getRoot(win.id);
    if (root === null) throw codedError(ERROR_CODES.BAD_ROOT, 'no workspace folder is open in this window');
    try {
      buildSearchRegExp(input.query);
    } catch (err) {
      throw codedError(ERROR_CODES.BAD_INPUT, `invalid regular expression: ${(err as Error).message}`);
    }
    service.start(target, input.searchId, input.query, root);
  };
}
