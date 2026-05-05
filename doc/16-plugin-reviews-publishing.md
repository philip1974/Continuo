# Plugin 评价响应手册(给作者)

用户在 Continuo 商店里评价你的插件。本文教你怎么看到、回复、用反馈改 plugin。

> 配套:
> - [doc/13-插件商店.md](./13-插件商店.md) — 商店架构
> - [doc/14-plugin-publishing.md](./14-plugin-publishing.md) — 上架手册
> - [doc/15-plugin-reviews.md](./15-plugin-reviews.md) — 评价系统计划
> - 评价存储:[philip1974/continuo-plugins](https://github.com/philip1974/continuo-plugins) Discussions

## 1. 评价存哪

所有 plugin 评价存在**索引仓库**(`philip1974/continuo-plugins`)的 Discussions tab。
每条评价是一个 Discussion,标题形如 `[your.plugin.id] 简短标题`。

不是你自己 plugin repo 的 Discussions。理由:
- 集中管理便于用户发现 + 维护者审核 spam
- plugin 作者不必额外开 Discussions 维护
- Continuo 端聚合查询只打一个 endpoint

## 2. 怎么看到自己 plugin 的评价

直接走 GitHub 搜索:

```
https://github.com/philip1974/continuo-plugins/discussions?discussions_q=[your.plugin.id]
```

把 `[your.plugin.id]` 换成你自家 manifest.id(带方括号)。

订阅这条搜索的 RSS / 在 GitHub 上 star + watch 索引仓库,新评价发布时
GitHub 通知到你邮箱。

## 3. 怎么回复

每条 discussion 是 GitHub Discussion,直接评论即可。

**好回复**:
- 谢谢用户 + 简明承诺(会修 / 已知限制 / 加到 roadmap)
- bug 类:复现步骤要清,引到你 plugin repo 提 issue 跟进
- 功能类:对/不对都说,理由透明

**别这样**:
- 跟用户吵
- 删评论(没权限,也别想)
- 用马甲账号刷好评(GitHub 看人头,反爬效率低,marketplace review 大概率
  会发现 → 撤掉 verified 标记)

## 4. 评价被 Continuo 怎么处理

Continuo app 端启动 / 用户点 ⟳ 刷新评分 时拉所有 discussions:
- 解析 title 第一对方括号 → plugin id
- 解析 body 抽 rating(★ 数 / 数字 1-5)
- 按 plugin id 聚合算 avg + count
- 卡片显 `★★★★☆ 4.2 (12 评价)`,展开显前 10 条

只有用 [discussion 模板](https://github.com/philip1974/continuo-plugins/discussions/new)
提交的 / 字段对得上 schema 的会被算入。瞎写的会被解析跳过。

## 5. 已知限制

- **删 review**:用户 / 维护者只能在 GitHub 上删,Continuo app 不提供
- **回复嵌套**:Continuo 卡片只显主评论,replies 要去 GitHub 看
- **markdown**:Continuo 卡片纯文本渲染 review body,markdown 语法字面显示。
  写评价的用户用 plain text 体验最好
- **图片 / 截图**:body 里 markdown 图片在 Continuo 卡片里显字面 `![](url)`,
  GitHub 上才能看到图

## 6. 你能影响评价的方式

**正向**:
- README / 文档清楚 → 用户写好评的时候有抓手
- 第一时间响应 issue / discussion → 显示作者活跃,用户更愿意正面评价
- changelog 里特别感谢提建议的人 → 用户感受到反馈被听到

**反向**(避免):
- 长期不维护(2+ 月无响应)→ 用户给低分 + 评论不推荐
- 强推付费版 / 升级提示 → 用户给低分
- 装上后 plugin 自动联网 telemetry 但不在 manifest 声明 → 信任崩塌

## 7. 维护者会怎么处理你的 plugin

- **新评价 spam**:维护者删,不影响你
- **集中差评**(数条 1 星 + 类似抱怨)→ 维护者可能 ping 你看怎么解
- **作者反复马甲刷分** → 警告 → 撤 verified → 长期不改 → 从索引下架

## 8. 反馈

不熟流程 / 流程不清楚 → 提 issue 到主仓 `philip1974/Continuo`。
