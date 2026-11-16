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

  // 打磨 P2-BM(E4 兄弟):nextWindowSeq 是安全整数但 ≤ 现存最大 windowSeq(计数回退/手改/旧版本写盘)
  // 时,此前原样分配 → 与现存段重复,两窗共享同一持久化段互相覆盖。seq 须 > 所有现存安全段。
  it('P2-BM: 安全但落后的 nextWindowSeq(≤ 现存最大段)→ 分配 max 段 + 1,不重复', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = 2;
    const tpl = payload.windows[0]!;
    payload.windows = [
      { ...tpl, windowSeq: 0 },
      { ...tpl, windowSeq: 5 },
    ];
    await atomicWriteJson(file, payload);

    expect(await allocateWindowSeq(file)).toBe(6);
    expect(await allocateWindowSeq(file)).toBe(7);
    expect((await loadExplorer(file))?.nextWindowSeq).toBe(8);
  });

  it('P2-BM: nextWindowSeq=0(下限)→ 至少分配 1(主窗占 0)', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = 0;
    payload.windows = [];
    await atomicWriteJson(file, payload);
    expect(await allocateWindowSeq(file)).toBe(1);
  });

  // 复审:现存段 windowSeq = MAX_SAFE_INTEGER 时 maxSeg+1 不安全(+1 后精度丢失)→ 每次分配同一不安全值,
  // 重新卡死重复。结果须是安全整数且不与现存段冲突;不安全时退化为最小未被占用的正整数(≥1)。
  it('现存段 windowSeq=MAX_SAFE_INTEGER → 退化为最小未占用正整数,连续分配不重复', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = 2;
    const tpl = payload.windows[0]!;
    payload.windows = [
      { ...tpl, windowSeq: 0 },
      { ...tpl, windowSeq: 1 },
      { ...tpl, windowSeq: Number.MAX_SAFE_INTEGER },
    ];
    await atomicWriteJson(file, payload);

    const a = await allocateWindowSeq(file);
    const b = await allocateWindowSeq(file);
    for (const seq of [a, b]) {
      expect(Number.isSafeInteger(seq)).toBe(true);
      expect([0, 1, Number.MAX_SAFE_INTEGER]).not.toContain(seq);
    }
    expect(a).toBe(2);
    expect(b).not.toBe(a);
    expect(Number.isSafeInteger((await loadExplorer(file))?.nextWindowSeq ?? NaN)).toBe(true);
  });

  it('nextWindowSeq=MAX_SAFE_INTEGER(seq+1 不安全)→ 同样退化为最小未占用正整数', async () => {
    const payload = defaultExplorerV3();
    (payload as { nextWindowSeq: number }).nextWindowSeq = Number.MAX_SAFE_INTEGER;
    await atomicWriteJson(file, payload);

    expect(await allocateWindowSeq(file)).toBe(1);
    expect(Number.isSafeInteger((await loadExplorer(file))?.nextWindowSeq ?? NaN)).toBe(true);
  });

  // 复审:退化扫描 `while (used.has(seq)) seq += 1` 从安全的计数起找,若其后一直到 MAX_SAFE_INTEGER 都被占用,
  // 会越过安全上界返回不安全 seq(+ 写回不安全 nextWindowSeq)。扫到下一值不安全须回绕到 1 继续找空位。
  it('退化扫描从计数起一路被占用到 MAX_SAFE_INTEGER → 回绕到 1 找空位,写回安全计数', async () => {
    const payload = defaultExplorerV3();
    const max = Number.MAX_SAFE_INTEGER;
    (payload as { nextWindowSeq: number }).nextWindowSeq = max - 2;
    const tpl = payload.windows[0]!;
    payload.windows = [
      { ...tpl, windowSeq: 0 },
      { ...tpl, windowSeq: 1 },
      { ...tpl, windowSeq: max - 2 },
      { ...tpl, windowSeq: max - 1 },
      { ...tpl, windowSeq: max },
    ];
    await atomicWriteJson(file, payload);

    const a = await allocateWindowSeq(file);
    const b = await allocateWindowSeq(file);
    expect(a).toBe(2);
    expect(b).toBe(3);
    expect(Number.isSafeInteger((await loadExplorer(file))?.nextWindowSeq ?? NaN)).toBe(true);
  });

  it('E4 自愈求 max windowSeq 使用单趟循环,不通过 reduce callback', () => {
    expect(allocateWindowSeq.toString()).not.toContain('.reduce(');
  });
});
