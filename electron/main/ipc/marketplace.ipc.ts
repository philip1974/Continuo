// 安全 S4:marketplace reviews IPC。token + GitHub fetch 在 main(见
// services/marketplace-reviews.service.ts),renderer 只经此通道拿聚合前的 nodes。

import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  MARKETPLACE_CHANNELS,
  type FetchReviewsResult,
} from '../../shared/marketplace-channels';
import { fetchReviewNodes } from '../services/marketplace-reviews.service';

// 无入参(查询参数全部由 main 固定),strict 空对象拒任何字段。zod schema 仅 main 用,
// 故放在本 main IPC 文件,不放 shared channels 文件(避免把 zod 拖进 sandbox preload)。
const fetchReviewsInputSchema = z.object({}).strict();

export function registerMarketplaceIpc(): void {
  safeHandle(
    MARKETPLACE_CHANNELS.FETCH_REVIEWS,
    fetchReviewsInputSchema,
    (): Promise<FetchReviewsResult> => fetchReviewNodes(),
    defaultIsTrustedFrame,
  );
}
