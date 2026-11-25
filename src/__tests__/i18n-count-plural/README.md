# i18n-count-plural(英文计数文案按单复数)

## 背景

en 计数文案固定复数或固定单数:状态栏「2 agent」、市场评分「(1 reviews)」、评价「1 thumbs up」、终端搜索「1 matches」。

## 行为

- 计数随数量变化且带可数名词的文案拆成 `<key>_one` / `<key>_other`,调用点走 `translateCount(baseKey, count)`
  (`src/i18n/translate.ts`,按 `Intl.PluralRules` 选择,见 statusbar-stats-plural):
  - `statusbar.agent_sessions`:1 agent / 2 agents
  - `marketplace.reviews.count`:(1 review) / (2 reviews)
  - `marketplace.reviews.thumbs_up`:1 like / 3 likes
  - `panels.terminal.search.match_total`:1 match / 20 matches;达上限的「1000+」固定用 `_other`
- zh / ko 无单复数之分:两 key 同文。
- 守护:en catalog 中含 `{count}` 的 key 必须满足其一 ——
  1. 是 `_one` / `_other` 成对 key;
  2. 文案用 `(s)` 兼容单复数;
  3. 在显式豁免表中(不带可数名词,或调用点保证计数 ≥ 2),新增带 `{count}` 的文案须在三者中择一。

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `count-plural.spec.tsx` | 守护 + 各调用点(StatusBar / 终端搜索计数)按单复数渲染;市场评价见 `marketplace-tab` |
