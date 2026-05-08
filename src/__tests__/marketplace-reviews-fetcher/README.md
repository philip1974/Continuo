# marketplace reviews-fetcher(评论拉取)

行为契约:**`fetchAllReviews` 用 GitHub GraphQL 翻页拉所有 discussion,
parseReview 抽出有效条目,按 pluginId 聚合 `PluginAggregateRating`。
1h memory + sessionStorage cache;无 token + 无 cache → 抛 NO_TOKEN;
有 token 但 fetch 失败时若有 cache → 静默 fallback。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/reviews-fetcher.ts` | fetch + 翻页 + 聚合 |
| `src/marketplace/reviews-parser.ts` | 单条 review 解析(已测) |

## 关键行为

### 缓存命中

- `memoryCache` 在 1h 内 → 直接返回,**不**走网络
- memoryCache 空时从 sessionStorage hydrate,新鲜则用

### forceRefresh=true

- 跳缓存,直接拉网络

### 无 VITE_GITHUB_TOKEN

- 有 cache(memory 或 session)→ 返 cache(不抛)
- 都没 cache → throw NO_TOKEN

### 翻页

- `pageInfo.hasNextPage=false` → 停
- `hasNextPage=true` → 用 `endCursor` 继续,直到 hasNextPage=false 或 50 页保护

### GraphQL errors 数组非空

- 抛 `GraphQL: ${msgs.join('; ')}`

### HTTP 非 2xx

- 抛 `HTTP ${status}`

### fetch 抛 + 有 cache

- console.warn + 返 cache

### fetch 抛 + 无 cache

- 透传抛

### 聚合

- 按 pluginId group;count = group.length;avg = sum(rating)/count
- reviews 按 GraphQL 提供的 createdAt DESC 顺序保留
