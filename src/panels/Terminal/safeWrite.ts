// xterm 写队列(从 MindAutonAgent 移植)。
// xterm.write 一次性大 buffer 会卡 UI 渲染;切 16KB chunks,8ms 一片让出主线程。
// 每个 Terminal 实例独立 queue,不并发(同 term 内顺序处理)。

import type { Terminal } from '@xterm/xterm';

const CHUNK_SIZE = 16 * 1024; // 16KB
const WRITE_INTERVAL_MS = 8;

export function chunkifyData(data: string, chunkSize: number): string[] {
  if (data.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  return chunks;
}

interface WriteQueue {
  queue: string[];
  writing: boolean;
}

const queues = new WeakMap<Terminal, WriteQueue>();

function getQueue(term: Terminal): WriteQueue {
  let q = queues.get(term);
  if (!q) {
    q = { queue: [], writing: false };
    queues.set(term, q);
  }
  return q;
}

export function safeWrite(term: Terminal, data: string): void {
  const q = getQueue(term);
  for (const chunk of chunkifyData(data, CHUNK_SIZE)) {
    q.queue.push(chunk);
  }
  drainQueue(term, q);
}

function drainQueue(term: Terminal, q: WriteQueue): void {
  if (q.writing) return;
  q.writing = true;

  const next = (): void => {
    const chunk = q.queue.shift();
    if (!chunk) {
      q.writing = false;
      return;
    }
    term.write(chunk);
    setTimeout(next, WRITE_INTERVAL_MS);
  };
  next();
}

export function disposeQueue(term: Terminal): void {
  queues.delete(term);
}
