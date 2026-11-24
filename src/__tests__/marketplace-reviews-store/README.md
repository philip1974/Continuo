# marketplace reviews-store

行为契约:**`useReviewsStore.refresh(force?)` 调 fetchAllReviews,成功 → set byPid + lastFetchedAt;
失败 → set error;loading 在 refresh 入口设 true,完成时清。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/reviews-store.ts` | zustand store |

## 关键行为

- refresh 成功:byPid 写入 + loading=false + lastFetchedAt 设
- refresh 抛 Error:error=err.message + loading=false
- refresh 抛 `MARKETPLACE_REVIEWS_NO_TOKEN`(main 未配置 GitHub token):**不是错误** —— error=null、unavailable=true、
  lastFetchedAt 设(本会话重开市场页不再反复请求);之后任一次成功清 unavailable
- refresh 抛非 Error 对象:error=String(err)
- force 参数透传 fetchAllReviews
