# search-query-limit(E279)

## 行为契约

搜索框 query 长度上限。`src/lib/search-query.ts` 的 `clampSearchQuery` / `MAX_SEARCH_QUERY_LEN` 是 Quick Open
与 Command Palette 等模糊搜索入口的单一来源。

query 不限长时,畸形粘贴超长字符串一次性进 fuzzyFilter → 对最多数千候选做小写化 + 模糊匹配 =
O(results × queryLen) CPU + 大字符串分配,单次 paste 卡死 renderer。各 store 的 `setQuery` 截断 query。

### 规则

1. `clampSearchQuery`:≤ MAX_SEARCH_QUERY_LEN 原样,超长截断到上限。
2. quick-open store 与 command-palette store 的 `setQuery` 都经 clampSearchQuery。
3. 家族接线守卫:两个 store 源码都调用 clampSearchQuery(防某入口漏接/回归)。
