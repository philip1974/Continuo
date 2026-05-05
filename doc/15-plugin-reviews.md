# 插件评分 / 评论计划书

> 状态:**计划阶段**,未实现。
> 前置:doc/13(插件商店架构)。
> 现实情况提醒:目前商店只有 1 个 plugin,评分系统在 < 5 个 plugin 阶段
> 价值低,**真正适合在商店有 10+ plugin 后启动**;本计划书先存档不实施。

## 1. 目标 / 非目标

**目标**

- 用户能在 marketplace 卡片看到每个 plugin 的星级 + 评价数
- 用户能展开看到具体评论(作者 / 时间 / 文本)
- 用户能写评论(无需 in-app OAuth — 跳转 GitHub 写)
- 零运营基础设施(继续跑在 GitHub 上,与 doc/13 一致)
- 减少作者刷分 / spam(靠 GitHub 现有的 spam 防护 + 维护者 review)

**非目标**

- 不做 in-app OAuth(GitHub 登录流程在桌面 app 麻烦,跳浏览器替代)
- 不做"已购"等门槛(plugin 都是免费 + 公开 git repo)
- 不做匿名评论(GitHub 账号即身份)
- 不做 5 维度细分打分(整体星级足够,简单 schema 早期才好维护)

## 2. 三方角色

| 角色 | 数据存哪 | 职责 |
|---|---|---|
| **评论存储** | `philip1974/continuo-plugins` 仓库的 **GitHub Discussions** | 唯一 source-of-truth |
| **GitHub web** | 写新评论的 UI(用户跳转过去用) | 不重复造写评论 UI |
| **Continuo app** | renderer 拉 GraphQL → 聚合显示 + 跳浏览器 | 只读展示 + 写入跳转 |

**为什么不用每个 plugin repo 自己的 Discussions?**

- 不强求 plugin 作者开 Discussions
- 用户找评论时只要去一个地方
- Continuo 端聚合查询只打一个 endpoint(rate limit 友好)
- 维护者(我们)审核 spam 集中处理

## 3. Discussion 形态

### 3.1 GitHub 端

在 `philip1974/continuo-plugins` 仓库:

- **Settings → Features → ✅ Discussions**(本仓库手动开启)
- **Discussion category**:`Reviews`(标 `discussion-category-form` 自动套模板)
- **Category template**(`.github/DISCUSSION_TEMPLATE/reviews.yml`):
  ```yaml
  title: "[plugin-id] 简短标题"
  labels: [review]
  body:
    - type: input
      id: plugin-id
      attributes:
        label: Plugin ID
        description: 例 com.example.sample
        placeholder: com.example.foo
      validations:
        required: true
    - type: dropdown
      id: rating
      attributes:
        label: 评分
        options: ['★ 1', '★★ 2', '★★★ 3', '★★★★ 4', '★★★★★ 5']
      validations:
        required: true
    - type: textarea
      id: review
      attributes:
        label: 评论
        description: 用了多久 / 解决了什么问题 / 还差什么
      validations:
        required: true
  ```

  → 用户在 GitHub web 提交时被强引导按 schema 填,Continuo 端 parse 容错少。

### 3.2 Continuo 端 schema

```ts
interface Review {
  pluginId: string;       // 从 title 第一对方括号 / 表单字段拿
  rating: 1 | 2 | 3 | 4 | 5;  // 从 body dropdown / 表单字段拿
  body: string;           // 评论正文
  author: { handle: string; avatarUrl: string };
  url: string;            // discussion 永久链接
  createdAt: string;      // ISO
}

interface PluginAggregateRating {
  pluginId: string;
  count: number;
  avg: number;            // 加权平均(所有 review rating 的算术平均)
  reviews: readonly Review[];  // 最近 N 条(默认 10)
}
```

## 4. Continuo 端实现

### 4.1 fetcher

新文件 `src/marketplace/reviews-fetcher.ts`:

```ts
const GRAPHQL = 'https://api.github.com/graphql';
// 拉所有 Reviews category 的 discussion(分页 100/次)
// 解析 title 抽 [pluginId],解析 body 抽 rating(★ 计数 / "Rating: X/5")
// 按 pluginId group 算 avg + count
export async function fetchAllReviews(): Promise<ReadonlyMap<string, PluginAggregateRating>>;
```

GraphQL query:
```graphql
{
  repository(owner: "philip1974", name: "continuo-plugins") {
    discussions(first: 100, categoryId: "...", orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        title body url createdAt
        author { login avatarUrl }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

**rate limit**:GraphQL 是 5000 points/hr authed,60 unauth。我们走 unauth(用户不登录),但加 1h cache(同 marketplace index)。每次启动拉一次,够。

### 4.2 store

`src/marketplace/reviews-store.ts`(zustand):

```ts
interface ReviewsState {
  byPid: ReadonlyMap<string, PluginAggregateRating>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}
```

启动时静默 refresh(同 update-store)。

### 4.3 UI 集成

**MarketplaceTab 卡片**新加一行:
```
Sample Plugin  ✓ verified  com.example.sample
演示 9 贡献点 + ...
★★★★☆ 4.2 (12 评价)              [展开查看 ▾]
by philip1974  sample · demo · v5         repo ↗
```

**展开 panel**:
- 列出最近 10 条评论(头像 / 用户名 / ★ / 日期 / 正文)
- 底部按钮 "[在 GitHub 写评论 ↗]" → `shell.openExternal` 跳到 Discussion 新建表单(URL 含 category + plugin id 预填)

**新评论后刷新**:
- 用户写完评论可能 1 小时内不显(cache),给个手动 [刷新评分] 按钮

### 4.4 反 spam / 质量

后端:
- Discussions 自带 GitHub spam 防护
- 维护者周期性 review,删 spam / 删机器人评论
- 仓库 settings 限制 trusted contributors only?(过于严,先不开)

前端:
- 显示评论作者的 GitHub registration date 角标(< 7 days 标 ⚠ "新账号")
- 同 plugin 同作者多评论合并展示(去重)
- 维护者评论 / verified 角标

## 5. 阶段拆分

### Phase 1 — 静态聚合(只读)
- [ ] continuo-plugins 仓库开 Discussions + Reviews category + 模板
- [ ] reviews-fetcher.ts:GraphQL query + parse rating from body
- [ ] reviews-store.ts(zustand)+ 1h cache
- [ ] MarketplaceTab 卡片增 ★ 行
- [ ] 启动静默 refresh
- 工作量:1 day

### Phase 2 — 展开列表
- [ ] 卡片"展开"按钮 → 显示最近 10 条 reviews
- [ ] 头像 / 时间 / 正文 markdown 渲染
- [ ] "写评论" 按钮 → shell.openExternal 跳 GitHub
- 工作量:0.5 day

### Phase 3 — UX 打磨
- [ ] 排序选项(最新 / 最有用 — GitHub reaction count)
- [ ] 新账号角标 / 维护者角标
- [ ] 手动 [刷新评分] 按钮
- 工作量:0.5 day

### Phase 4 — 文档
- [ ] doc/16-plugin-reviews-publishing.md(plugin 作者视角:怎么响应评论)
- [ ] continuo-plugins README 加"如何评价插件"段
- 工作量:0.3 day

**总计 ≈ 2.3 day**(Phase 1 是大头,Phase 2-4 累加)。

## 6. 风险 / 待定

| 风险 | 缓解 |
|---|---|
| 早期 review 极少 → 卡片显空状态丑 | 没 review 不显 ★ 行,不留 placeholder |
| 用户跑 Continuo 不登 GitHub → unauth GraphQL 60/hr 撞墙 | 1h cache;真撞退守 cached;Phase 5 加 OAuth(可选) |
| 作者刷分 | discussion author = GitHub user 可见,人工 review 拉黑;前端去重同人多评 |
| body parse 失败(用户没用模板)| 容错跳过,不计入 count |
| GraphQL endpoint 改 schema | 集中一个 fetcher,改一处即可 |
| 跨 plugin 类型评分基准不同(theme vs dev-tool)| 不解决,展示绝对 ★ 让用户自判;后续若需可分类型 |
| 评论恶语 / 人身攻击 | 维护者人工删除;`.github/CODE_OF_CONDUCT.md` 加上 |

## 7. 开放问题

1. **空 review 的 plugin 怎么显**?— 不显评分 vs 显"暂无评价"占位。建议 不显
2. **作者本人评论自家插件**?— 允许但角标"作者";不计入 avg 防刷
3. **"有用"投票**(👍 reaction)用不用?— 用,GitHub 原生支持,parse 反应数即可
4. **未 verified plugin 评分要不要显**?— 显,但加"未 review"标签提醒用户判断
5. **"举报评论"流程**?— 不做 in-app,提示用户去 GitHub 举报 spam
6. **历史评分 / 趋势图**?— 不做 v1,3+ 版本每版有 review 后再考虑

## 8. 启动门槛(什么时候开始做)

- 商店 plugin 数 ≥ **10**
- 每月新增 plugin ≥ **2**
- 已有用户主动询问"哪个好用?"

任一未达 → 继续 defer,这文档就当未来开工时的施工说明。

## 9. 关联

- doc/13 插件商店架构 — reviews 是商店的 v1.5 子功能
- doc/14 plugin 发布手册 — 后续加"作者怎么响应评论"段
- v5 权限系统 — reviews 不需要新权限(纯外部 GraphQL,不走 plugin sandbox)
