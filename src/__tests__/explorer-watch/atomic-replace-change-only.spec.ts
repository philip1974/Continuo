// 性能:编辑器原子保存(写 `.<name>.continuo.tmp` 再 rename 覆盖)在 macOS 上的 fs.watch 事件同 tick 内为
// ['rename', tmp]、['rename', name]×2,无 'change' → 合并器 changeOnly 恒 false,每次保存都让 Explorer 整目录
// listDir + 整树 rebuild。覆盖**已有**文件时目录列表不变:atomicWriteFile 在写 tmp 前登记目标名 + tmp 名,
// 合并器 flush 时该目录本 tick 的文件名全部是登记名 → changeOnly:true。新建文件 / 混入外部文件名 / 过期 /
// crash 残留 tmp → 按原语义(false,刷新)。

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSameTickPathCoalescer } from '../../../electron/main/ipc/fs/watch';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';
import {
  RECENT_ATOMIC_REPLACE_MAX,
  RECENT_ATOMIC_REPLACE_TTL_MS,
  atomicWriteTmpName,
  claimAtomicReplaceNames,
  markAtomicReplace,
  resetAtomicReplaceMarksForTest,
} from '../../../electron/main/ipc/fs/recent-atomic-replace';

function manualSchedule() {
  const queued: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      queued.push(fn);
    },
    run: () => {
      for (const fn of queued.splice(0)) fn();
    },
  };
}

beforeEach(() => resetAtomicReplaceMarksForTest());
afterEach(() => {
  vi.useRealTimers();
  resetAtomicReplaceMarksForTest();
});

describe('原子替换登记表', () => {
  it('tmp 名为 .<name>.continuo.tmp', () => {
    expect(atomicWriteTmpName('a.md')).toBe('.a.md.continuo.tmp');
  });

  it('全部名字已登记 → true 并消费;再次同名 → false(之后的外部变化按原语义刷新)', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplaceNames('/r', ['.a.md.continuo.tmp', 'a.md'])).toBe(true);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['.a.md.continuo.tmp'])).toBe(false);
  });

  it('只见 tmp(目标事件尚未到)→ true 但不消费目标', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplaceNames('/r', ['.a.md.continuo.tmp'])).toBe(true);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(true);
  });

  it('混入未登记名 / 别的目录 / 大小写不同 → false 且不消费', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplaceNames('/r', ['a.md', 'new.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/other', ['a.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['A.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['.b.md.continuo.tmp'])).toBe(false); // 非本次的 tmp 名
    expect(claimAtomicReplaceNames('/r', [])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(true);
  });

  it('TTL 过期 → false', () => {
    vi.useFakeTimers();
    markAtomicReplace('/r', 'a.md');
    vi.advanceTimersByTime(RECENT_ATOMIC_REPLACE_TTL_MS + 1);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(false);
  });

  it('条目数有上限:超出淘汰最早登记', () => {
    for (let i = 0; i <= RECENT_ATOMIC_REPLACE_MAX; i++) markAtomicReplace('/r', `f${i}`);
    expect(claimAtomicReplaceNames('/r', ['f0'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', [`f${RECENT_ATOMIC_REPLACE_MAX}`])).toBe(true);
  });
});

describe('合并器 + 原子替换判定', () => {
  it('同 tick 该目录文件名全是登记名(rename 事件)→ changeOnly:true;未注入判定 → 旧语义 false', () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, claimAtomicReplaceNames);
    push('/r', '.a.md.continuo.tmp', 'rename');
    push('/r', 'a.md', 'rename');
    push('/r', 'a.md', 'rename');
    s.run();
    expect(emit.mock.calls).toEqual([['/r', ['.a.md.continuo.tmp', 'a.md'], true]]);

    const emit2 = vi.fn();
    const s2 = manualSchedule();
    const plain = createSameTickPathCoalescer(emit2, s2.schedule);
    markAtomicReplace('/r', 'a.md');
    plain('/r', 'a.md', 'rename');
    s2.run();
    expect(emit2.mock.calls).toEqual([['/r', ['a.md'], false]]);
  });

  it('同 tick 混入外部新建文件 / 缺 filename → false', () => {
    markAtomicReplace('/r', 'a.md');
    markAtomicReplace('/q', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, claimAtomicReplaceNames);
    push('/r', 'a.md', 'rename');
    push('/r', 'new.md', 'rename');
    push('/q', 'a.md', 'rename');
    push('/q');
    s.run();
    expect(emit.mock.calls).toEqual([
      ['/r', ['a.md', 'new.md'], false],
      ['/q', undefined, false],
    ]);
  });
});

describe('atomicWriteFile 登记', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function tempDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'continuo-aw-replace-'));
    dirs.push(d);
    return d;
  }

  it('覆盖已有文件 → 登记目标名与 tmp 名', async () => {
    const d = await tempDir();
    await writeFile(join(d, 'a.md'), 'x');
    await atomicWriteFile(join(d, 'a.md'), 'y');
    expect(claimAtomicReplaceNames(d, ['.a.md.continuo.tmp', 'a.md'])).toBe(true);
  });

  it('新建文件 → 不登记', async () => {
    const d = await tempDir();
    await atomicWriteFile(join(d, 'new.md'), 'y');
    expect(claimAtomicReplaceNames(d, ['new.md'])).toBe(false);
    expect(claimAtomicReplaceNames(d, ['.new.md.continuo.tmp'])).toBe(false);
  });

  it('tmp 撞上 crash 残留(其删除对显示隐藏文件的 Explorer 可见)→ 不登记', async () => {
    const d = await tempDir();
    await writeFile(join(d, 'a.md'), 'x');
    await writeFile(join(d, '.a.md.continuo.tmp'), 'stale');
    await atomicWriteFile(join(d, 'a.md'), 'y');
    expect(claimAtomicReplaceNames(d, ['.a.md.continuo.tmp'])).toBe(false);
    expect(claimAtomicReplaceNames(d, ['a.md'])).toBe(false);
  });
});
