import { describe, it, expect, beforeEach } from 'vitest';
import { usePinnedStore } from '../../stores/pinned.store';

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
});
