import { describe, it, expect } from 'vitest';
import { parseReview } from '../../marketplace/reviews-parser';

const AUTHOR = { login: 'alice', avatarUrl: 'https://avatars.example/alice' };

const TEMPLATE_BODY = `### Plugin ID

com.example.foo

### 评分

★★★★★ 5

### 评论正文

很好用,推荐。

### Continuo 版本(可选)

0.1.0

### Plugin 版本(可选)

0.2.0`;

describe('parseReview — 模板正路径', () => {
  it('完整模板 → 全字段抽出', () => {
    const r = parseReview({
      title: '[com.example.foo] great',
      body: TEMPLATE_BODY,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: AUTHOR,
    });
    expect(r).not.toBeNull();
    expect(r!.pluginId).toBe('com.example.foo');
    expect(r!.rating).toBe(5);
    expect(r!.body).toBe('很好用,推荐。');
    expect(r!.author.handle).toBe('alice');
    expect(r!.continuoVersion).toBe('0.1.0');
    expect(r!.pluginVersion).toBe('0.2.0');
  });
});

describe('parseReview — pluginId 容错', () => {
  it('body 缺 Plugin ID section → fallback title 第一对方括号', () => {
    const body = `### 评分\n★★★ 3\n### 评论正文\nmid`;
    const r = parseReview({
      title: '[com.bar] not bad',
      body,
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.pluginId).toBe('com.bar');
  });

  it('title 也缺 → null', () => {
    const r = parseReview({
      title: 'no brackets here',
      body: '### 评分\n5\n### 评论正文\ntext',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });
});

describe('parseReview — rating 解析', () => {
  it('"★★★★★ 5" → 5', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n★★★★★ 5\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(5);
  });

  it('"★ 1" → 1', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n★ 1\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(1);
  });

  it('纯数字 "3/5" → 3', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n3/5\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(3);
  });

  it('rating section 缺 → null(不计)', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });

  it('rating 超界(6 / 0)→ null', () => {
    const r1 = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n6\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r1).toBeNull();
    const r2 = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n0\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r2).toBeNull();
  });
});

describe('parseReview — 边界', () => {
  it('author null → null(GitHub 删账号了)', () => {
    const r = parseReview({
      title: '[a]',
      body: TEMPLATE_BODY.replace('com.example.foo', 'a'),
      url: 'x',
      createdAt: 'now',
      author: null,
    });
    expect(r).toBeNull();
  });

  it('正文段空白 → null', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n3\n### 评论正文\n   \n',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });

  it('title 抽出 pluginId 校 [a-z0-9._-]+ 字符集', () => {
    const r = parseReview({
      title: '[com.foo-bar_baz.1] ok',
      body: '### 评分\n3\n### 评论正文\nx',
      url: 'x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.pluginId).toBe('com.foo-bar_baz.1');
  });
});
