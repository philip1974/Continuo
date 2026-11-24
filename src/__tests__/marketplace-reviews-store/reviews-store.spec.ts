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
    unavailable: false,
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

describe('useReviewsStore.refresh — 未配置 GitHub token', () => {
  // 未配置 token 是正常状态(评分功能不可用),不是刷新失败:不写 error(否则市场页每次打开都一行红字),
  // 记 unavailable 供 UI 在用户手动刷新后给中性提示;记 lastFetchedAt,本会话重开市场页不再反复请求。
  it('NO_TOKEN → unavailable=true、error=null、lastFetchedAt 设', async () => {
    fetchMock.mockRejectedValue(new Error('MARKETPLACE_REVIEWS_NO_TOKEN'));
    await useReviewsStore.getState().refresh();
    const s = useReviewsStore.getState();
    expect(s.error).toBeNull();
    expect(s.unavailable).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.lastFetchedAt).not.toBeNull();
  });

  it('其它失败仍写 error;之后成功则清 unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('MARKETPLACE_REVIEWS_NO_TOKEN'));
    await useReviewsStore.getState().refresh();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await useReviewsStore.getState().refresh(true);
    expect(useReviewsStore.getState().error).toBe('network down');
    fetchMock.mockResolvedValueOnce(new Map());
    await useReviewsStore.getState().refresh(true);
    expect(useReviewsStore.getState().unavailable).toBe(false);
    expect(useReviewsStore.getState().error).toBeNull();
  });
});
