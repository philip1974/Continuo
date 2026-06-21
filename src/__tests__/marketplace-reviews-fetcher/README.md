# marketplace reviews-fetcher(评论拉取)

行为契约:**`fetchAllReviews` 经 IPC(`coApi.marketplace.fetchReviews`)从 main 拿聚合前的
discussion nodes,parseReview 抽出有效条目,按 pluginId 聚合 `PluginAggregateRating`。
1h memory + sessionStorage cache;main 无 token(`available:false`)+ 无 cache → 抛
NO_TOKEN;IPC/网络失败时若有 cache → 静默 fallback。**

> 安全 S4(codex 安全审计):token + GitHub GraphQL fetch + 翻页全在 **main 进程**
> (`electron/main/services/marketplace-reviews.service.ts`,token 走运行时 `GITHUB_TOKEN`,
> 绝不内联进 renderer 产物)。renderer 再无 `VITE_GITHUB_TOKEN` / 直连 GitHub。
> 见 `src/__tests__/49-polish-bugfixes/security-marketplace-token-main.spec.ts`。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/marketplace-reviews.service.ts` | token + GraphQL fetch + 翻页(main) |
| `src/marketplace/reviews-fetcher.ts` | IPC 取 nodes + 聚合 + 缓存(renderer) |
| `src/marketplace/reviews-parser.ts` | 单条 review 解析(已测) |

## 关键行为

### 缓存命中

- `memoryCache` 在 1h 内 → 直接返回,**不**走 IPC
- memoryCache 空时从 sessionStorage hydrate,新鲜则用

### forceRefresh=true

- 跳缓存,重新走 IPC

### main 无 token(`available:false`)

- 有 cache(memory 或 session)→ 返 cache(不抛)
- 都没 cache → throw NO_TOKEN

### 翻页(main 侧职责)

- main `pageInfo.hasNextPage=true` → 用 `endCursor` 继续,直到 false 或 50 页保护;
  renderer 一次性收到全量 nodes 再聚合

### IPC ok:false / 网络错误

- 有 cache → console.warn + 返 cache
- 无 cache → 透传抛(message,如 `HTTP 503`)

### 聚合

- 按 pluginId group;count = group.length;avg = sum(rating)/count
- reviews 按 GraphQL 提供的 createdAt DESC 顺序保留
