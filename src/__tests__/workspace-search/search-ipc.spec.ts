// BDD: workspace-search / 4 IPC 与服务:只搜发送窗口的工作区根、新查询取消旧查询、取消 / 窗口离开终止 worker、
// 事件转发带 searchId、worker 崩溃转成 error 事件、入参 schema 限长、preload 推送守卫
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createTextSearchService,
  makeSearchStartHandler,
  searchCancelInputSchema,
  searchStartInputSchema,
  type SearchWorkerLike,
} from '../../../electron/main/services/text-search.service';
import {
  SEARCH_CHANNELS,
  SEARCH_GLOB_MAX,
  SEARCH_ID_MAX,
  SEARCH_PATTERN_MAX,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';
import { MAX_SEARCH_QUERY_LEN } from '@/lib/search-query';

const query: SearchQuery = { pattern: 'foo', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '' };

class FakeWorker implements SearchWorkerLike {
  readonly handlers: Record<string, ((arg: unknown) => void)[]> = {};
  terminated = false;
  constructor(readonly data: { root: string; query: SearchQuery }) {}
  on(event: string, cb: (arg: never) => void): this {
    (this.handlers[event] ??= []).push(cb as (arg: unknown) => void);
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const service = createTextSearchService((data) => {
    const w = new FakeWorker(data);
    workers.push(w);
    return w;
  });
  const sent: unknown[] = [];
  const target = { id: 7, send: vi.fn((_ch: string, payload: unknown) => sent.push(payload)), isDestroyed: () => false };
  return { service, workers, sent, target };
}

describe('搜索服务', () => {
  it('worker 收到根与查询;结果 / 结束事件带 searchId 经 search:event 转发', () => {
    const { service, workers, sent, target } = setup();
    service.start(target, 's1', query, '/w');
    expect(workers[0]!.data).toEqual({ root: '/w', query });
    workers[0]!.emit('message', { kind: 'files', files: [] });
    workers[0]!.emit('message', { kind: 'done', limitHit: false, filesLimitHit: false });
    expect(target.send.mock.calls.every(([ch]) => ch === SEARCH_CHANNELS.EVENT)).toBe(true);
    expect(sent).toEqual([
      { searchId: 's1', kind: 'files', files: [] },
      { searchId: 's1', kind: 'done', limitHit: false, filesLimitHit: false },
    ]);
  });

  it('同一窗口新查询终止旧 worker,旧 worker 迟到的消息不再转发', () => {
    const { service, workers, sent, target } = setup();
    service.start(target, 's1', query, '/w');
    service.start(target, 's2', query, '/w');
    expect(workers[0]!.terminated).toBe(true);
    workers[0]!.emit('message', { kind: 'done', limitHit: false, filesLimitHit: false });
    expect(sent).toEqual([]);
    // 别的窗口的搜索互不影响
    const other = { id: 8, send: vi.fn(), isDestroyed: () => false };
    service.start(other, 's3', query, '/x');
    expect(workers[1]!.terminated).toBe(false);
  });

  it('取消:终止当前 worker;不是当前 searchId 时 no-op;窗口离开取消全部', () => {
    const { service, workers, target } = setup();
    service.start(target, 's1', query, '/w');
    service.cancel(target.id, 'other');
    expect(workers[0]!.terminated).toBe(false);
    service.cancel(target.id, 's1');
    expect(workers[0]!.terminated).toBe(true);
    service.start(target, 's2', query, '/w');
    service.cancelAll(target.id);
    expect(workers[1]!.terminated).toBe(true);
  });

  it('worker 崩溃 / 异常退出 → error 事件;正常结束后退出不再发', () => {
    const { service, workers, sent, target } = setup();
    service.start(target, 's1', query, '/w');
    workers[0]!.emit('error', new Error('boom'));
    expect(sent).toEqual([{ searchId: 's1', kind: 'error', code: 'SEARCH_FAILED', message: 'boom' }]);
    service.start(target, 's2', query, '/w');
    workers[1]!.emit('message', { kind: 'done', limitHit: false, filesLimitHit: false });
    workers[1]!.emit('exit', 0);
    expect(sent).toHaveLength(2);
    service.start(target, 's3', query, '/w');
    workers[2]!.emit('exit', 1);
    expect(sent.at(-1)).toMatchObject({ searchId: 's3', kind: 'error' });
  });

  it('窗口已销毁:不投递,终止 worker', () => {
    const { service, workers } = setup();
    const gone = { id: 9, send: vi.fn(), isDestroyed: () => true };
    service.start(gone, 's1', query, '/w');
    workers[0]!.emit('message', { kind: 'files', files: [] });
    expect(gone.send).not.toHaveBeenCalled();
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('search:start 处理', () => {
  const win = { id: 7 };
  it('根取自发送窗口(renderer 不传根);无工作区 → BAD_ROOT', () => {
    const service = { start: vi.fn(), cancel: vi.fn(), cancelAll: vi.fn() };
    const roots = new Map([[7, '/w']]);
    const handler = makeSearchStartHandler(service, (id) => roots.get(id) ?? null);
    const target = { id: 70, send: vi.fn() };
    handler({ searchId: 's', query }, win, target);
    expect(service.start).toHaveBeenCalledWith(target, 's', query, '/w');
    expect(() => handler({ searchId: 's', query }, { id: 8 }, target)).toThrow(expect.objectContaining({ code: 'BAD_ROOT' }));
  });
  it('非法正则 → BAD_INPUT,不起 worker', () => {
    const service = { start: vi.fn(), cancel: vi.fn(), cancelAll: vi.fn() };
    const handler = makeSearchStartHandler(service, () => '/w');
    expect(() => handler({ searchId: 's', query: { ...query, pattern: 'a(', isRegex: true } }, win, { id: 1, send: vi.fn() })).toThrow(
      expect.objectContaining({ code: 'BAD_INPUT' }),
    );
    expect(service.start).not.toHaveBeenCalled();
  });
  it('schema:.strict()、空查询拒绝、长度上限(pattern 与 renderer 截断同一上限)', () => {
    expect(SEARCH_PATTERN_MAX).toBe(MAX_SEARCH_QUERY_LEN);
    const ok = { searchId: 's', query };
    expect(searchStartInputSchema.safeParse(ok).success).toBe(true);
    expect(searchStartInputSchema.safeParse({ ...ok, root: '/etc' }).success).toBe(false);
    expect(searchStartInputSchema.safeParse({ ...ok, query: { ...query, root: '/' } }).success).toBe(false);
    expect(searchStartInputSchema.safeParse({ ...ok, query: { ...query, pattern: '' } }).success).toBe(false);
    expect(searchStartInputSchema.safeParse({ ...ok, query: { ...query, pattern: 'x'.repeat(SEARCH_PATTERN_MAX + 1) } }).success).toBe(false);
    expect(searchStartInputSchema.safeParse({ ...ok, query: { ...query, include: 'x'.repeat(SEARCH_GLOB_MAX + 1) } }).success).toBe(false);
    expect(searchStartInputSchema.safeParse({ ...ok, searchId: 'x'.repeat(SEARCH_ID_MAX + 1) }).success).toBe(false);
    expect(searchCancelInputSchema.safeParse({ searchId: 's' }).success).toBe(true);
    expect(searchCancelInputSchema.safeParse({ searchId: 's', x: 1 }).success).toBe(false);
  });
});

describe('接线', () => {
  const root = path.resolve(__dirname, '../../..');
  const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
  it('IPC 注册:start / cancel 走 safeHandle 管线,worker 在独立线程;窗口离开(关闭 / 重载 / 崩溃)取消', () => {
    const ipc = read('electron/main/ipc/search.ipc.ts');
    expect(ipc).toMatch(/safeHandleWithCtx\(SEARCH_CHANNELS\.START/);
    expect(ipc).toMatch(/safeHandleWithCtx\(SEARCH_CHANNELS\.CANCEL/);
    expect(ipc).toMatch(/\?nodeWorker'/);
    expect(ipc).toMatch(/makeWcGoneHook/);
    expect(read('electron/main/ipc.ts')).toMatch(/registerSearchIpc\(\)/);
  });
  it('preload 订阅推送经 isSearchEvent 守卫', () => {
    const preload = read('electron/preload/index.ts');
    expect(preload).toMatch(/guardedListener\(\s*isSearchEvent/);
    expect(preload).toMatch(/SEARCH_CHANNELS\.EVENT/);
  });
});
