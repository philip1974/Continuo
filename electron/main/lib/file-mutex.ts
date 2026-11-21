import { createSerialQueue } from '../../shared/run-serial-per-key';

/**
 * Per-file async mutex(无 reentrant)。
 *
 * 用法:
 *   await withExplorerFileMutex(async () => {
 *     const payload = await loadExplorer(file);
 *     // ... patch ...
 *     await atomicWriteJson(file, payload);
 *   });
 *
 * 约束:持锁区严禁发 IPC、严禁调用会再次拿同一锁的 helper(no reentrant)。
 */

const queue = createSerialQueue();

export function withExplorerFileMutex<T>(fn: () => Promise<T>): Promise<T> {
  return queue.run(fn);
}

/** Test helper: reset chain to allow isolated tests. */
export function _resetExplorerFileMutex(): void {
  queue.reset();
}
