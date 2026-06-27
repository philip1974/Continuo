// 搜索框 query 长度上限(Quick Open / Command Palette 等模糊搜索入口共用)。
//
// 边界(E279):query 不限长时,畸形粘贴超长字符串一次性进 fuzzyFilter —— 对最多数千候选做
// 小写化 + 模糊匹配 = O(results × queryLen) CPU + 大字符串分配,单次 paste 即可卡死 renderer。
// setQuery 处截断到合理上限(真实搜索 query 远短于此);各搜索入口复用同一常量,消漂移。

export const MAX_SEARCH_QUERY_LEN = 1024;

/** 截断 query 到 MAX_SEARCH_QUERY_LEN(超长 paste 防 O(results×queryLen) 放大)。 */
export function clampSearchQuery(q: string): string {
  return q.length > MAX_SEARCH_QUERY_LEN ? q.slice(0, MAX_SEARCH_QUERY_LEN) : q;
}
