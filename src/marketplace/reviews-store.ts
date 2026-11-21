// 评论 store(doc/15 Phase 1):wrap fetcher 给 React 订阅。

import { create } from 'zustand';
import { fetchAllReviews } from './reviews-fetcher';
import type { PluginAggregateRating } from './reviews-types';
import { errorMessage } from '../../electron/shared/error-message';

interface ReviewsState {
  readonly byPid: ReadonlyMap<string, PluginAggregateRating>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly lastFetchedAt: number | null;
  refresh(force?: boolean): Promise<void>;
}

// 单调代际:并发 refresh 时,慢的请求可能后 resolve;只让最新代际落库,
// 避免过期结果覆盖更新结果(同 update-store)。
let reviewsRefreshGen = 0;

export const useReviewsStore = create<ReviewsState>((set) => ({
  byPid: new Map(),
  loading: false,
  error: null,
  lastFetchedAt: null,
  refresh: async (force = false) => {
    const myGen = ++reviewsRefreshGen;
    set((s) =>
      s.loading && s.error === null ? s : { loading: true, error: null },
    );
    try {
      const byPid = await fetchAllReviews(force);
      if (myGen !== reviewsRefreshGen) return;
      set({ byPid, loading: false, lastFetchedAt: Date.now() });
    } catch (err) {
      if (myGen !== reviewsRefreshGen) return;
      set({
        loading: false,
        error: errorMessage(err),
      });
    }
  },
}));
