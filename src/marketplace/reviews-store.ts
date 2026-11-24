// 评论 store(doc/15 Phase 1):wrap fetcher 给 React 订阅。

import { create } from 'zustand';
import { fetchAllReviews } from './reviews-fetcher';
import { REVIEWS_NO_TOKEN_CODE, type PluginAggregateRating } from './reviews-types';
import { errorMessage } from '../../electron/shared/error-message';
import { createLatestGuard } from '@/lib/latest-wins';

interface ReviewsState {
  readonly byPid: ReadonlyMap<string, PluginAggregateRating>;
  readonly loading: boolean;
  readonly error: string | null;
  /**
   * main 未配置 GitHub token → 评分功能不可用(正常的未配置状态,不是错误)。此时 error 保持 null,
   * UI 静默不显示评分;仅用户手动点「刷新评分」后给一行中性提示(对齐 VSCode 市场无鉴权时不报错)。
   */
  readonly unavailable: boolean;
  readonly lastFetchedAt: number | null;
  refresh(force?: boolean): Promise<void>;
}

// 单调代际:并发 refresh 时,慢的请求可能后 resolve;只让最新代际落库,
// 避免过期结果覆盖更新结果(同 update-store)。
const reviewsRefreshGuard = createLatestGuard();

export const useReviewsStore = create<ReviewsState>((set) => ({
  byPid: new Map(),
  loading: false,
  error: null,
  unavailable: false,
  lastFetchedAt: null,
  refresh: async (force = false) => {
    const isLatest = reviewsRefreshGuard.begin();
    set((s) =>
      s.loading && s.error === null ? s : { loading: true, error: null },
    );
    try {
      const byPid = await fetchAllReviews(force);
      if (!isLatest()) return;
      set({ byPid, loading: false, unavailable: false, lastFetchedAt: Date.now() });
    } catch (err) {
      if (!isLatest()) return;
      const message = errorMessage(err);
      // 未配置 token:记为「不可用」并记 lastFetchedAt(本会话重开市场页不再反复请求),不当错误。
      if (message === REVIEWS_NO_TOKEN_CODE) {
        set({ loading: false, error: null, unavailable: true, lastFetchedAt: Date.now() });
        return;
      }
      set({
        loading: false,
        error: message,
      });
    }
  },
}));
