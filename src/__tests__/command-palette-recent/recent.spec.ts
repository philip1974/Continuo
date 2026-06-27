// @vitest-environment jsdom
// BDD: command-palette-recent / store

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useRecentCommandsStore,
  RECENT_STORAGE_KEY,
  MAX_RECENT,
} from '../../plugins/command-palette/recent';

beforeEach(() => {
  // 清 localStorage + reset store
  try {
    localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    /* */
  }
  useRecentCommandsStore.setState({ list: [] });
});

describe('useRecentCommandsStore', () => {
  it('初始 list 为空', () => {
    expect(useRecentCommandsStore.getState().list).toEqual([]);
  });

  it('record(id) → 加到头部', () => {
    useRecentCommandsStore.getState().record('a');
    const { list } = useRecentCommandsStore.getState();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('a');
    expect(typeof list[0]?.ts).toBe('number');
  });

  it('多次 record 不同 id → 最新在头部', () => {
    useRecentCommandsStore.getState().record('a');
    useRecentCommandsStore.getState().record('b');
    useRecentCommandsStore.getState().record('c');
    expect(useRecentCommandsStore.getState().list.map((e) => e.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('重复 record 同 id → 移到头部 + 更新 ts(不重复)', () => {
    useRecentCommandsStore.getState().record('a');
    useRecentCommandsStore.getState().record('b');
    useRecentCommandsStore.getState().record('a'); // 重新执行 a
    const { list } = useRecentCommandsStore.getState();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe('a');
    expect(list[1]?.id).toBe('b');
  });

  it(`list 上限 MAX_RECENT(=${MAX_RECENT}),溢出从尾部丢弃`, () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) {
      useRecentCommandsStore.getState().record(`cmd-${i}`);
    }
    const { list } = useRecentCommandsStore.getState();
    expect(list).toHaveLength(MAX_RECENT);
    // 头部是最新(MAX_RECENT+4),尾部是溢出后留下来的最早一条
    expect(list[0]?.id).toBe(`cmd-${MAX_RECENT + 4}`);
  });

  it('clear() 清空 list + 清 localStorage', () => {
    useRecentCommandsStore.getState().record('a');
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).not.toBeNull();
    useRecentCommandsStore.getState().clear();
    expect(useRecentCommandsStore.getState().list).toEqual([]);
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });
});

describe('useRecentCommandsStore · localStorage 持久化', () => {
  it('record 后 localStorage 写入', () => {
    useRecentCommandsStore.getState().record('a');
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Array<{ id: string; ts: number }>;
    expect(parsed[0]?.id).toBe('a');
  });

  it('record 抛(localStorage 不可用)→ 静默,in-memory 仍更新', () => {
    // 模拟 storage 满 / 隐私模式
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => useRecentCommandsStore.getState().record('a')).not.toThrow();
      expect(useRecentCommandsStore.getState().list[0]?.id).toBe('a');
    } finally {
      localStorage.setItem = original;
    }
  });

  it('clear 抛(localStorage 不可用)→ 静默,in-memory 仍清空', () => {
    useRecentCommandsStore.getState().record('a');
    const original = localStorage.removeItem;
    localStorage.removeItem = () => {
      throw new Error('failed');
    };
    try {
      expect(() => useRecentCommandsStore.getState().clear()).not.toThrow();
      expect(useRecentCommandsStore.getState().list).toEqual([]);
    } finally {
      localStorage.removeItem = original;
    }
  });
});

describe('useRecentCommandsStore · readFromStorage 防御', () => {
  it('JSON 损坏 → 空数组', async () => {
    localStorage.setItem(RECENT_STORAGE_KEY, 'not-json');
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([]);
  });

  it('值不是数组 → 空数组', async () => {
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify({ not: 'array' }),
    );
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([]);
  });

  it('数组中包含非法形态项 → 跳过,只保留合法项', async () => {
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([
        { id: 'good', ts: 100 },
        { id: 'no-ts' }, // 缺 ts
        { ts: 999 }, // 缺 id
        null,
        'not an object',
        { id: 'good2', ts: 200 },
      ]),
    );
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([
      { id: 'good', ts: 100 },
      { id: 'good2', ts: 200 },
    ]);
  });

  it('合法数据 → hydrate', async () => {
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([{ id: 'cmd.x', ts: 1234 }]),
    );
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([
      { id: 'cmd.x', ts: 1234 },
    ]);
  });

  // 边界(E39,E5/E22 持久化读回族):readFromStorage 不止校验类型,还要 ts 有限 + id 长度 +
  // 按 MAX_RECENT 截断,挡篡改 localStorage 的非有限 ts / 超长 id / 超大数组放大开销。
  it('E39 非有限 ts(NaN/Infinity)→ 丢弃', async () => {
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      // JSON 无 NaN/Infinity 字面量;1e400 解析为 Infinity
      '[{"id":"a","ts":1e400},{"id":"b","ts":100}]',
    );
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([
      { id: 'b', ts: 100 },
    ]);
  });

  it('E39 超长 id(>256)→ 丢弃', async () => {
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([
        { id: 'x'.repeat(257), ts: 1 },
        { id: 'ok', ts: 2 },
      ]),
    );
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([
      { id: 'ok', ts: 2 },
    ]);
  });

  it('E39 超大数组 → 读回截断到 MAX_RECENT', async () => {
    const huge = Array.from({ length: MAX_RECENT * 3 }, (_, i) => ({
      id: `cmd-${i}`,
      ts: i,
    }));
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(huge));
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    const list = mod.useRecentCommandsStore.getState().list;
    expect(list).toHaveLength(MAX_RECENT);
    // 截断保留头部(最近优先),即前 MAX_RECENT 条。
    expect(list[0]?.id).toBe('cmd-0');
    expect(list[MAX_RECENT - 1]?.id).toBe(`cmd-${MAX_RECENT - 1}`);
  });

  // 边界(E209,E208 同族有界迭代):readFromStorage 用惰性循环凑满 MAX_RECENT 即停,不先
  // parsed.filter(isRecentEntry) 全量扫描+物化再 slice。结果与旧 filter+slice 相同(前 MAX_RECENT 合法),
  // 故用 Array.prototype.filter spy(按 999 长度筛选,免并行污染)验"不再对超大数组调 filter"。
  it('E209 readFromStorage 不对超大数组调 .filter(凑满即停)', async () => {
    const big = Array.from({ length: 999 }, (_, i) => ({ id: `cmd-${i}`, ts: i }));
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(big));
    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    const list = mod.useRecentCommandsStore.getState().list;
    const filteredBig = filterSpy.mock.instances.some(
      (inst) => Array.isArray(inst) && (inst as unknown[]).length === 999,
    );
    filterSpy.mockRestore();
    expect(filteredBig).toBe(false); // 新实现不对 999-len 数组 filter(旧 filter+slice 会)
    expect(list).toHaveLength(MAX_RECENT); // 结果回归:前 MAX_RECENT 合法
  });

  // 边界(E72,E70/E71 解析前上限族):raw 字符串 >256KiB → 解析前拦,返 [] 并清毒(removeItem)。
  // 用足量合法小条目让序列化串超 256KiB:若无 cap 会 parse+slice 出 MAX_RECENT 条,有 cap → []。
  it('E72 raw 超 256KiB → 解析前返 [] 并清 key(不 parse/不截断到 MAX_RECENT)', async () => {
    const many = Array.from({ length: 12000 }, (_, i) => ({
      id: `cmd-${i}`,
      ts: i,
    }));
    const raw = JSON.stringify(many);
    expect(raw.length).toBeGreaterThan(256 * 1024); // 确认确实超上限
    localStorage.setItem(RECENT_STORAGE_KEY, raw);
    vi.resetModules();
    const mod = await import('../../plugins/command-palette/recent');
    expect(mod.useRecentCommandsStore.getState().list).toEqual([]); // 非 MAX_RECENT 条
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull(); // 清毒
  });
});

// race(R10,R6 同型):多窗口 lost update —— 本窗 in-memory 陈旧时 record 须基于 live localStorage
// 合并,不丢别窗刚记录的命令。
describe('useRecentCommandsStore · R10 多窗口 lost update', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      /* */
    }
    useRecentCommandsStore.setState({ list: [] });
  });

  it('record 基于 live localStorage:不丢别窗刚记录的命令', () => {
    // 别窗已记录 cmd.other(直接落 localStorage);本窗 in-memory 陈旧(空)。
    localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([{ id: 'cmd.other', ts: 1000 }]),
    );
    useRecentCommandsStore.setState({ list: [] });

    // 本窗记录自己的命令 → merge live(含 cmd.other),而非整表覆盖。
    useRecentCommandsStore.getState().record('cmd.mine');

    const persisted = JSON.parse(
      localStorage.getItem(RECENT_STORAGE_KEY)!,
    ) as { id: string }[];
    expect(persisted.map((e) => e.id)).toEqual(['cmd.mine', 'cmd.other']);
    expect(useRecentCommandsStore.getState().list.map((e) => e.id)).toEqual([
      'cmd.mine',
      'cmd.other',
    ]);
  });
});
