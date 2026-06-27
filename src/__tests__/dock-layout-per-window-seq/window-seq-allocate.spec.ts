import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  allocateWindowSeq,
  defaultExplorerV3,
  loadExplorer,
} from '../../../electron/main/persistence';
import { atomicWriteJson } from '../../../electron/main/lib/atomic-write';
import { _resetExplorerFileMutex } from '../../../electron/main/lib/file-mutex';

describe('allocateWindowSeq atomic concurrent allocation', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    _resetExplorerFileMutex();
    dir = await mkdtemp(path.join(tmpdir(), 'lm-alloc-'));
    file = path.join(dir, 'explorer.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('T28a: single call returns current nextWindowSeq and increments it', async () => {
    await atomicWriteJson(file, defaultExplorerV3());

    const seq = await allocateWindowSeq(file);

    expect(seq).toBe(1);
    const loaded = await loadExplorer(file);
    expect(loaded?.nextWindowSeq).toBe(2);
  });

  it('T28b: missing file creates default v3 and returns 1', async () => {
    const seq = await allocateWindowSeq(file);

    expect(seq).toBe(1);
    const loaded = await loadExplorer(file);
    expect(loaded?.nextWindowSeq).toBe(2);
  });

  it(
    'T28c: 100 concurrent calls return 100 unique seqs',
    async () => {
      await atomicWriteJson(file, defaultExplorerV3());

      const seqs = await Promise.all(
        Array.from({ length: 100 }, () => allocateWindowSeq(file)),
      );

      expect(new Set(seqs).size).toBe(100);
      const loaded = await loadExplorer(file);
      expect(loaded?.nextWindowSeq).toBe(101);
    },
    20_000,
  );

  // 边界(E4):损坏持久化里 nextWindowSeq >= Number.MAX_SAFE_INTEGER 时 `seq + 1` 因浮点精度
  // 不变 → 计数器卡死,每个新窗口拿同一 windowSeq → 多窗共享同一持久化段互相覆盖。自愈:检测
  // 不安全整数则重算为 max(现有段 windowSeq, 0)+1,恢复唯一且单调。
  it('E4: 损坏的 nextWindowSeq(2^53,不安全整数)→ 自愈,分配唯一单调安全 seq', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = 2 ** 53; // seq+1===seq
    await atomicWriteJson(file, payload);

    const a = await allocateWindowSeq(file);
    const b = await allocateWindowSeq(file);

    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(1); // 主窗占 0,新窗 >=1
    expect(b).toBe(a + 1); // 不再卡死,正常自增
    expect(a).not.toBe(b); // 两窗不共享同一 seq
    const loaded = await loadExplorer(file);
    expect(Number.isSafeInteger(loaded?.nextWindowSeq ?? NaN)).toBe(true);
  });

  it('E4: 健康 nextWindowSeq 不触发自愈(行为不变)', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = 7;
    await atomicWriteJson(file, payload);
    expect(await allocateWindowSeq(file)).toBe(7); // 安全值原样返回
    expect((await loadExplorer(file))?.nextWindowSeq).toBe(8);
  });
});
