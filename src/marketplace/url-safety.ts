// 边界(E108/E109):marketplace 外部数据(index entry authorUrl、reviews 的 review.url /
// author.avatarUrl)会被 UI 直接渲染成 <a href> / <img src>。畸形/恶意 index、被篡改的
// sessionStorage 缓存或畸形 GraphQL 响应可放入 javascript:/file:/smb:/data: 等非 http(s) 协议 →
// DOM 中出现不可信可点击外链 / 危险 src,且不应依赖 Electron windowOpenHandler 拦截链兜底。
// 在数据契约边界统一只接受可解析的 http/https URL。types.ts(entry)与 reviews-types.ts(review)共用。

/** 仅当 u 是可解析且 protocol 为 http:/https: 的 URL 时返回 true。 */
export function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
