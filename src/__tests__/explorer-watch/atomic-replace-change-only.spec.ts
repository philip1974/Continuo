// 性能:编辑器原子保存(写 `.<name>.continuo.tmp` 再 rename 覆盖)在 macOS 上的 fs.watch 事件同 tick 内为
// ['rename', tmp]、['rename', name]×2,无 'change' → 合并器 changeOnly 恒 false,每次保存都让 Explorer 整目录
// listDir + 整树 rebuild。覆盖**已有**文件时目录列表不变:atomicWriteFile 在写 tmp 前登记目标名 + tmp 名,
// 合并器 flush 时该目录本 tick 的文件名全部是登记名 → changeOnly:true。新建文件 / 混入外部文件名 / 过期 /
// crash 残留 tmp → 按原语义(false,刷新)。

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSameTickPathCoalescer } from '../../../electron/main/ipc/fs/watch';
import { FS_CHANNELS } from '../../../electron/shared/fs-channels';
import {
  ownReplaceFs,
  registerFsIpc,
  releaseFsWatchersForWindow,
} from '../../../electron/main/ipc/fs.ipc';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';
import {
  RECENT_ATOMIC_REPLACE_MAX,
  RECENT_ATOMIC_REPLACE_TTL_MS,
  atomicWriteTmpName,
  claimAtomicReplace,
  claimAtomicReplaceNames,
  clearAtomicReplaceMarksInDir,
  markAtomicReplace,
  resetAtomicReplaceMarksForTest,
} from '../../../electron/main/ipc/fs/recent-atomic-replace';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: (event: unknown, raw: unknown) => Promise<unknown>) =>
      m.handlers.set(channel, h),
  },
  BrowserWindow: {
    fromWebContents: () => ({ id: 9 }),
    getAllWindows: () => [],
    fromId: () => null,
  },
  dialog: {},
  shell: {},
}));

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

  it('别的目录 / 大小写不同 / 非本次 tmp → false 且不消费', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplaceNames('/other', ['a.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['A.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['.b.md.continuo.tmp'])).toBe(false); // 非本次的 tmp 名
    expect(claimAtomicReplaceNames('/r', [])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(true);
  });

  it('混入未登记名 → false,但其中出现的登记目标名(连同 tmp)照样消费:之后同名外部变化按原语义刷新', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplaceNames('/r', ['.a.md.continuo.tmp', 'a.md', 'b.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['.a.md.continuo.tmp'])).toBe(false);
  });

  it('claimAtomicReplace 返回本次消费的目标名(只见 tmp → 空数组;非全部登记 → null)', () => {
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplace('/r', ['.a.md.continuo.tmp'])).toEqual([]);
    expect(claimAtomicReplace('/r', ['.a.md.continuo.tmp', 'a.md'])).toEqual(['a.md']);
    markAtomicReplace('/r', 'a.md');
    expect(claimAtomicReplace('/r', ['a.md', 'x'])).toBeNull();
  });

  it('clearAtomicReplaceMarksInDir 清掉该目录(仅该目录)的全部登记', () => {
    markAtomicReplace('/r', 'a.md');
    markAtomicReplace('/r', 'b.md');
    markAtomicReplace('/r/sub', 'a.md');
    clearAtomicReplaceMarksInDir('/r');
    expect(claimAtomicReplaceNames('/r', ['a.md'])).toBe(false);
    expect(claimAtomicReplaceNames('/r', ['.b.md.continuo.tmp'])).toBe(false);
    expect(claimAtomicReplaceNames('/r/sub', ['a.md'])).toBe(true);
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

function ownReplace(
  isRegularFile: (dir: string, name: string) => Promise<boolean> = async () => true,
) {
  return { claim: claimAtomicReplace, clearDir: clearAtomicReplaceMarksInDir, isRegularFile };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('合并器 + 原子替换判定', () => {
  it('同 tick 该目录文件名全是登记名(rename 事件)→ changeOnly:true;未注入判定 → 旧语义 false', () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace());
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
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace());
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

  it('保存与外部新建同批(混批)后,随后的外部删除 a.md → 非 changeOnly(登记已在混批中消费)', () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace());
    push('/r', '.a.md.continuo.tmp', 'rename');
    push('/r', 'a.md', 'rename');
    push('/r', 'b.md', 'rename');
    s.run();
    push('/r', 'a.md', 'rename');
    s.run();
    expect(emit.mock.calls).toEqual([
      ['/r', ['.a.md.continuo.tmp', 'a.md', 'b.md'], false],
      ['/r', ['a.md'], false],
    ]);
  });

  it('文件名超上限 / 缺 filename 退化为未知文件 → 清掉该目录全部登记', () => {
    markAtomicReplace('/r', 'a.md');
    markAtomicReplace('/q', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, 2, ownReplace());
    push('/r', 'a.md', 'rename');
    push('/r', 'x', 'rename');
    push('/r', 'y', 'rename');
    push('/q');
    s.run();
    push('/r', 'a.md', 'rename');
    push('/q', 'a.md', 'rename');
    s.run();
    expect(emit.mock.calls).toEqual([
      ['/r', undefined, false],
      ['/q', undefined, false],
      ['/r', ['a.md'], false],
      ['/q', ['a.md'], false],
    ]);
  });

  it('全 change 事件的批同样消费出现的登记目标,之后同名 rename 按原语义刷新', () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace());
    push('/r', 'a.md', 'change');
    s.run();
    push('/r', 'a.md', 'rename');
    s.run();
    expect(emit.mock.calls).toEqual([
      ['/r', ['a.md'], true],
      ['/r', ['a.md'], false],
    ]);
  });

  it('按登记判为 changeOnly 后复查目标:已不存在 / 非普通文件 → 补发一次非 changeOnly', async () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const isRegularFile = vi.fn(async () => false);
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace(isRegularFile));
    push('/r', '.a.md.continuo.tmp', 'rename');
    push('/r', 'a.md', 'rename');
    s.run();
    expect(emit.mock.calls).toEqual([['/r', ['.a.md.continuo.tmp', 'a.md'], true]]);
    await flushAsync();
    expect(isRegularFile.mock.calls).toEqual([['/r', 'a.md']]);
    expect(emit.mock.calls).toEqual([
      ['/r', ['.a.md.continuo.tmp', 'a.md'], true],
      ['/r', ['.a.md.continuo.tmp', 'a.md'], false],
    ]);
  });

  it('复查抛错按「不再是文件」处理(宁多刷新)', async () => {
    markAtomicReplace('/r', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const push = createSameTickPathCoalescer(
      emit,
      s.schedule,
      undefined,
      ownReplace(async () => {
        throw new Error('EACCES');
      }),
    );
    push('/r', 'a.md', 'rename');
    s.run();
    await flushAsync();
    expect(emit.mock.calls).toEqual([
      ['/r', ['a.md'], true],
      ['/r', ['a.md'], false],
    ]);
  });

  it('目标仍是普通文件 → 不补发;只见 tmp(未消费目标)/ 事件本身全 change → 不复查', async () => {
    markAtomicReplace('/r', 'a.md');
    markAtomicReplace('/q', 'a.md');
    const emit = vi.fn();
    const s = manualSchedule();
    const isRegularFile = vi.fn(async () => true);
    const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplace(isRegularFile));
    push('/r', '.a.md.continuo.tmp', 'rename');
    push('/q', 'a.md', 'change');
    s.run();
    await flushAsync();
    expect(isRegularFile).not.toHaveBeenCalled();
    push('/r', 'a.md', 'rename');
    s.run();
    await flushAsync();
    expect(isRegularFile.mock.calls).toEqual([['/r', 'a.md']]);
    expect(emit.mock.calls).toEqual([
      ['/r', ['.a.md.continuo.tmp'], true],
      ['/q', ['a.md'], true],
      ['/r', ['a.md'], true],
    ]);
  });

  it('真实 fs:原子保存后同批外部删除目标 → 复查 ENOENT 补发非 changeOnly;目标仍在 → 不补发', async () => {
    const d = await mkdtemp(join(tmpdir(), 'continuo-aw-recheck-'));
    try {
      await writeFile(join(d, 'a.md'), 'x');
      await writeFile(join(d, 'b.md'), 'x');
      await atomicWriteFile(join(d, 'a.md'), 'y');
      await atomicWriteFile(join(d, 'b.md'), 'y');
      await rm(join(d, 'a.md'));
      const emit = vi.fn();
      const s = manualSchedule();
      const push = createSameTickPathCoalescer(emit, s.schedule, undefined, ownReplaceFs);
      push(d, '.a.md.continuo.tmp', 'rename');
      push(d, 'a.md', 'rename');
      s.run();
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
      expect(emit.mock.calls[1]).toEqual([d, ['.a.md.continuo.tmp', 'a.md'], false]);

      emit.mockClear();
      push(d, 'b.md', 'rename');
      s.run();
      await new Promise((r) => setTimeout(r, 50));
      expect(emit.mock.calls).toEqual([[d, ['b.md'], true]]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('fs:watch 新装目录 watcher 时清掉该目录闲置登记(Linux 未展开目录不 watch)', () => {
  it('WATCH 之后该目录的旧登记不再把外部变化判为 changeOnly', async () => {
    const d = await mkdtemp(join(tmpdir(), 'continuo-aw-watch-'));
    try {
      registerFsIpc();
      markAtomicReplace(d, 'a.md');
      markAtomicReplace(`${d}-other`, 'a.md');
      const sender = Object.assign(new EventEmitter(), { id: 900 });
      const r = (await m.handlers.get(FS_CHANNELS.WATCH)!(
        { sender, senderFrame: { url: 'file:///app/index.html' } },
        { path: d },
      )) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(claimAtomicReplaceNames(d, ['a.md'])).toBe(false);
      expect(claimAtomicReplaceNames(`${d}-other`, ['a.md'])).toBe(true);
    } finally {
      releaseFsWatchersForWindow(9);
      await rm(d, { recursive: true, force: true });
    }
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
