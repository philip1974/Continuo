// 评论 store(doc/15 Phase 1):wrap fetcher 给 React 订阅。

import { create } from 'zustand';
import { fetchAllReviews } from './reviews-fetcher';
import type { PluginAggregateRating } from './reviews-types';

interface ReviewsState {
  readonly byPid: ReadonlyMap<string, PluginAggregateRating>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly lastFetchedAt: number | null;
  refresh(force?: boolean): Promise<void>;
}

export const useReviewsStore = create<ReviewsState>((set) => ({
  byPid: new Map(),
  loading: false,
  error: null,
  lastFetchedAt: null,
  refresh: async (force = false) => {
    set({ loading: true, error: null });
    try {
      const byPid = await fetchAllReviews(force);
      set({ byPid, loading: false, lastFetchedAt: Date.now() });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
