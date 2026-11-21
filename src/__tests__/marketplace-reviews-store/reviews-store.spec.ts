import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../marketplace/reviews-fetcher', () => ({
  fetchAllReviews: vi.fn(),
}));

import { useReviewsStore } from '../../marketplace/reviews-store';
import { fetchAllReviews } from '../../marketplace/reviews-fetcher';

const fetchMock = fetchAllReviews as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
  useReviewsStore.setState({
    byPid: new Map(),
    loading: false,
    error: null,
    lastFetchedAt: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe('useReviewsStore.refresh', () => {
  it('成功 → byPid + loading=false + lastFetchedAt 设', async () => {
    const map = new Map<string, never>();
    map.set('a', { pluginId: 'a' } as never);
    fetchMock.mockResolvedValue(map);
    await useReviewsStore.getState().refresh();
    const s = useReviewsStore.getState();
    expect(s.loading).toBe(false);
    expect(s.byPid.size).toBe(1);
    expect(s.lastFetchedAt).not.toBeNull();
  });

  it('refresh 期间 loading=true', async () => {
    let release: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const p = useReviewsStore.getState().refresh();
    expect(useReviewsStore.getState().loading).toBe(true);
    release(new Map());
    await p;
    expect(useReviewsStore.getState().loading).toBe(false);
  });

  it('refresh 已处于 loading 且无 error 时不重复通知等价入口状态', async () => {
    useReviewsStore.setState({ loading: true, error: null });
    let release: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const listener = vi.fn();
    const unsubscribe = useReviewsStore.subscribe(listener);

    try {
      const p = useReviewsStore.getState().refresh();

      expect(listener).not.toHaveBeenCalled();
      release(new Map());
      await p;
    } finally {
      unsubscribe();
    }
  });

  it('Error 抛 → error=err.message', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await useReviewsStore.getState().refresh();
    expect(useReviewsStore.getState().error).toBe('offline');
    expect(useReviewsStore.getState().loading).toBe(false);
  });

  it('非 Error 抛 → error=String(err)', async () => {
     
    fetchMock.mockRejectedValue('weird-string');
    await useReviewsStore.getState().refresh();
    expect(useReviewsStore.getState().error).toBe('weird-string');
  });

  it('force 参数透传 fetchAllReviews', async () => {
    fetchMock.mockResolvedValue(new Map());
    await useReviewsStore.getState().refresh(true);
    expect(fetchMock).toHaveBeenCalledWith(true);
  });

  it('refresh 入口清掉之前的 error', async () => {
    useReviewsStore.setState({ error: 'old error' });
    fetchMock.mockResolvedValue(new Map());
    await useReviewsStore.getState().refresh();
    expect(useReviewsStore.getState().error).toBeNull();
  });
});
