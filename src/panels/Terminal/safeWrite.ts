// xterm 写队列(从 MindAutonAgent 移植)。
// xterm.write 一次性大 buffer 会卡 UI 渲染;切 16KB chunks,8ms 一片让出主线程。
// 每个 Terminal 实例独立 queue,不并发(同 term 内顺序处理)。
//
// 首屏 burst:前 BURST_CHUNKS 个 chunk 同步连写不让出,让 shell prompt /
// banner 立刻出现(典型 prompt < 16KB 是单 chunk,但 starship/p10k 等富
// prompt 可能多 chunk,被 8ms 节流累计到几百 ms 的可见延迟)。
// 大输出场景(N > BURST)走原节流逻辑保护 UI。

import type { Terminal } from '@xterm/xterm';

const CHUNK_SIZE = 16 * 1024; // 16KB
const WRITE_INTERVAL_MS = 8;
const BURST_CHUNKS = 4; // 前 4 chunk(≤64KB)同步直写,首屏 prompt 0 延迟

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
  let written = 0;

  const next = (): void => {
    const chunk = q.queue.shift();
    if (!chunk) {
      q.writing = false;
      return;
    }
    term.write(chunk);
    written++;
    // 首 N 个 chunk 同步连写(让 prompt 第一时间出现);超出后回到节流模式。
    if (written < BURST_CHUNKS) {
      next();
    } else {
      setTimeout(next, WRITE_INTERVAL_MS);
    }
  };
  next();
}

export function disposeQueue(term: Terminal): void {
  queues.delete(term);
}
