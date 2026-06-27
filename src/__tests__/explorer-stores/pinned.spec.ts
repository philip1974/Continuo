import { describe, it, expect, beforeEach } from 'vitest';
import { usePinnedStore } from '../../stores/pinned.store';
import {
  PINNED_MAX,
  PATH_STR_MAX,
} from '../../../electron/shared/explorer-persistence-schema';

beforeEach(() => {
  usePinnedStore.setState({ paths: [] });
});

describe('pinned.store', () => {
  it('初态:paths 空', () => {
    expect(usePinnedStore.getState().paths).toEqual([]);
  });

  it('toggle 未 pin → 加入(置后)', () => {
    usePinnedStore.getState().toggle('/a');
    usePinnedStore.getState().toggle('/b');
    expect(usePinnedStore.getState().paths).toEqual(['/a', '/b']);
  });

  it('toggle 已 pin → 移除', () => {
    usePinnedStore.setState({ paths: ['/a', '/b', '/c'] });
    usePinnedStore.getState().toggle('/b');
    expect(usePinnedStore.getState().paths).toEqual(['/a', '/c']);
  });

  it('clear 清空', () => {
    usePinnedStore.setState({ paths: ['/a', '/b'] });
    usePinnedStore.getState().clear();
    expect(usePinnedStore.getState().paths).toEqual([]);
  });

  it('toggle 不去重相同 path 多次调用顺序对', () => {
    usePinnedStore.getState().toggle('/a');
    usePinnedStore.getState().toggle('/a'); // off
    usePinnedStore.getState().toggle('/a'); // on
    expect(usePinnedStore.getState().paths).toEqual(['/a']);
  });

  // 边界(E276,运行时状态守持久化契约):pin 数达 PINNED_MAX 后再 toggle 新 path → 拒加(no-op),
  // 防超持久化 schema 上限致 explorer:write 拒整份。已 pin 的仍可移除。
  it('E276 达 PINNED_MAX 后新 pin 被拒(不超持久化上限)', () => {
    const full = Array.from({ length: PINNED_MAX }, (_, i) => `/p${i}`);
    usePinnedStore.setState({ paths: full });
    usePinnedStore.getState().toggle('/overflow');
    expect(usePinnedStore.getState().paths.length).toBe(PINNED_MAX);
    expect(usePinnedStore.getState().paths.includes('/overflow')).toBe(false);
    // 已 pin 的仍可移除(降到上限内)
    usePinnedStore.getState().toggle('/p0');
    expect(usePinnedStore.getState().paths.length).toBe(PINNED_MAX - 1);
  });

  it('E276 超长 path(>PATH_STR_MAX)→ 拒加', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    usePinnedStore.getState().toggle(longPath);
    expect(usePinnedStore.getState().paths).toEqual([]);
  });
});
