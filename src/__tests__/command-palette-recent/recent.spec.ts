// @vitest-environment jsdom
// BDD: command-palette-recent / store

import { describe, it, expect, beforeEach } from 'vitest';
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
});
