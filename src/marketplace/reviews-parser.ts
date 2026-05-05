// review discussion body / title 解析(纯函数,易测)。
//
// GitHub discussion form template 提交后,body 形如:
//   ### Plugin ID
//   com.example.foo
//   ### 评分
//   ★★★★★ 5
//   ### 评论正文
//   多行文字...
//   ### Continuo 版本(可选)
//   0.1.0
//
// 我们 split by "### " 收 sections,容错(用户自己写也兼容简单形态)。

import type { Review } from './reviews-types';

interface RawDiscussion {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly author: {
    readonly login: string;
    readonly avatarUrl: string;
    /** Phase 3:GraphQL `User { createdAt }`. 缺时给 epoch 0(被标新账号). */
    readonly createdAt?: string;
  } | null;
  /** Phase 3:THUMBS_UP reaction 总数,缺给 0. */
  readonly thumbsUp?: number;
}

/** 失败返 null(skip 这条 review,不污染聚合). */
export function parseReview(raw: RawDiscussion): Review | null {
  const sections = parseSections(raw.body);

  // pluginId:优先 body section,fallback title 第一对方括号
  const pluginId =
    sections.get('plugin id')?.trim() ?? extractPluginIdFromTitle(raw.title);
  if (!pluginId) return null;

  const ratingRaw = sections.get('评分') ?? sections.get('rating');
  const rating = parseRating(ratingRaw);
  if (rating === null) return null;

  const body =
    sections.get('评论正文')?.trim() ??
    sections.get('review')?.trim() ??
    raw.body.trim();
  if (body.length === 0) return null;

  if (!raw.author) return null;

  return {
    pluginId,
    rating,
    body,
    author: {
      handle: raw.author.login,
      avatarUrl: raw.author.avatarUrl,
      createdAt: raw.author.createdAt ?? '1970-01-01T00:00:00Z',
    },
    thumbsUp: raw.thumbsUp ?? 0,
    url: raw.url,
    createdAt: raw.createdAt,
    continuoVersion: sections.get('continuo 版本(可选)')?.trim() ?? undefined,
    pluginVersion: sections.get('plugin 版本(可选)')?.trim() ?? undefined,
  };
}

/** "### Foo\nbar baz\n### Qux\n..." → Map { foo: "bar baz", qux: ... }(key 小写). */
function parseSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let curKey: string | null = null;
  let curBuf: string[] = [];
  const flush = () => {
    if (curKey) out.set(curKey, curBuf.join('\n').trim());
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      curKey = (m[1] ?? '').toLowerCase();
      curBuf = [];
    } else if (curKey) {
      curBuf.push(line);
    }
  }
  flush();
  return out;
}

function extractPluginIdFromTitle(title: string): string | null {
  const m = title.match(/^\s*\[([a-z0-9._-]+)\]/i);
  return m ? (m[1] ?? null) : null;
}

function parseRating(raw: string | undefined): Review['rating'] | null {
  if (!raw) return null;
  // "★★★★★ 5" / "★★★ 3" / "5" / "5/5" 都能解析
  const stars = (raw.match(/★/g) ?? []).length;
  if (stars >= 1 && stars <= 5) return stars as Review['rating'];
  const m = raw.match(/\b([1-5])\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5) return n as Review['rating'];
  }
  return null;
}
