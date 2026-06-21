// 安全 S4:marketplace reviews IPC。token + GitHub fetch 在 main(见
// services/marketplace-reviews.service.ts),renderer 只经此通道拿聚合前的 nodes。

import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  MARKETPLACE_CHANNELS,
  fetchReviewsInputSchema,
  type FetchReviewsResult,
} from '../../shared/marketplace-channels';
import { fetchReviewNodes } from '../services/marketplace-reviews.service';

export function registerMarketplaceIpc(): void {
  safeHandle(
    MARKETPLACE_CHANNELS.FETCH_REVIEWS,
    fetchReviewsInputSchema,
    (): Promise<FetchReviewsResult> => fetchReviewNodes(),
    defaultIsTrustedFrame,
  );
}
