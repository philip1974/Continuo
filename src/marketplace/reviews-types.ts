// 插件评分 / 评论类型(doc/15 Phase 1)。
//
// review 数据存 GitHub Discussions(philip1974/continuo-plugins),
// reviews-fetcher.ts 走 GraphQL 拉 + parse → 这里的形态。

export interface Review {
  /** 从 discussion title 第一对方括号 / body 表单字段抽出的 plugin id. */
  readonly pluginId: string;
  readonly rating: 1 | 2 | 3 | 4 | 5;
  /** 评论正文(剥掉 schema 段头,只留 review section). */
  readonly body: string;
  readonly author: {
    readonly handle: string;
    readonly avatarUrl: string;
    /** Phase 3:author GitHub 账号注册时间(ISO),"新账号"角标用. */
    readonly createdAt: string;
  };
  /** 永久链接,点 → 跳 GitHub. */
  readonly url: string;
  readonly createdAt: string; // ISO
  /** Phase 3:THUMBS_UP reaction 总数,排序"最有用"用. */
  readonly thumbsUp: number;
  /** 可选:Continuo / plugin 版本. */
  readonly continuoVersion?: string;
  readonly pluginVersion?: string;
}

export interface PluginAggregateRating {
  readonly pluginId: string;
  readonly count: number;
  /** 算术平均(无加权). */
  readonly avg: number;
  /** 倒序按 createdAt(最新在前),最多 N 条(默认全收,UI 自截). */
  readonly reviews: readonly Review[];
}
