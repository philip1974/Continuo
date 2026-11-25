# statusbar-stats-plural(状态栏行 / 词 / 字符统计的单复数)

## 背景

en 状态栏统计固定复数:「2 lines · 1 words · 5 chars」。

## 行为

- `statusbar.editor_stats` 为 `{lines} · {words} · {chars}`,每段由 `translateCount(baseKey, count)`(`src/i18n/translate.ts`)
  按当前语言的 `Intl.PluralRules` 选 `<baseKey>_one` / `<baseKey>_other` 并以 `{count}` 插值。
- en:1 → 单数(1 line / 1 word / 1 char),其余(含 0)→ 复数。zh / ko 复数规则恒为 other,两 key 同文。
- 仓库 i18n 原无复数机制,此为最小实现(只区分 one / other)。
