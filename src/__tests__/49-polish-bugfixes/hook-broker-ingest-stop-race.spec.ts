// @vitest-environment node
// race(R90):HookFileBroker.ingestFile() 只在入口查 stopped,stat/readFile 的 await 期间若
// stop()(清空 pending/buffered/processed)甚至 restart,迟到的 ingestFile 仍 processed.set/
// 匹配 pending/buffered.push → 重污染已清空(或新一代)状态,后续 await_stop_hook 误消费上代事件。
// 修复:ingest 代际(stop 时 +1)+ 每个 await 后复查 stopped + gen 未变,过期则丢弃。
//
// 用 fs mock 暂停 stat 的 await:stop() 后 resolve → 有修复则在 readFile 之前 bail(readFile 不
// 被调用);无修复则继续读文件 + 写状态。

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statResolvers: [] as Array<(v: { mtimeMs: number }) => void>,
  readdirResult: [] as string[],
  readFileText: '{"session_id":"s"}',
}));

vi.mock('node:fs', () => ({
  watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}));

// E211/E212:readHookDirCapped 由 readdir 改 opendir 流式枚举 —— mock 用 opendir 产出 readdirResult 名单。
const fsp = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  opendir: vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const name of h.readdirResult) yield { name };
    },
    close: async () => undefined,
  })),
  stat: vi.fn(
    () =>
      new Promise<{ mtimeMs: number }>((r) => {
        h.statResolvers.push(r);
      }),
  ),
  readFile: vi.fn(async () => h.readFileText),
  unlink: vi.fn(async () => undefined),
}));
vi.mock('node:fs/promises', () => fsp);

import { createHookFileBroker } from '../../../electron/main/services/mcp-tools-hook-bridge';

afterEach(() => {
  h.statResolvers = [];
  h.readdirResult = [];
  vi.clearAllMocks();
});

describe('race(R90) · ingestFile 在 stat 期间 stop 不污染', () => {
  it('stat 在途时 stop() → ingestFile 在 readFile 前 bail(不读文件、不写状态)', async () => {
    h.readdirResult = ['codex_4_123.jsonl']; // codex runner,合法文件名
    const broker = createHookFileBroker('/fake/dir');
    try {
      // start():mkdir(mock)→ watch(mock)→ opendir 流式枚举(yield 该文件)→ ingestFile → 卡在 stat(deferred)。
      // opendir 异步迭代比旧 readdir 多几个微任务 tick,多 flush 直到 ingest 挂上 stat(stat 被 deferred 阻塞,
      // 多 flush 安全不会越过)。
      const startP = broker.start();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
      expect(h.statResolvers.length).toBe(1); // ingest 已挂在 stat
      expect(fsp.readFile).not.toHaveBeenCalled();

      // stat 在途时停止 broker(清空状态 + bump ingestGen)。
      await broker.stop();

      // 放行 stat → ingestFile 恢复 → 复查 stopped/gen → 在 readFile 之前 bail。
      h.statResolvers[0]!({ mtimeMs: Date.now() });
      await Promise.resolve();
      await Promise.resolve();
      await startP;

      // 关键:bail 在 readFile 之前 → 文件未被读、状态未被污染。
      expect(fsp.readFile).not.toHaveBeenCalled();
    } finally {
      await broker.stop(); // 清掉 start 尾部可能设的 cleanup interval
    }
  });
});
