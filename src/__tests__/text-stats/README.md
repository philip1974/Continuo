# text-stats(StatusBar 用统计)

行为契约:**字符串行数 / 词数 / 字符数**纯函数。
StatusBar 实时显示当前 active editor tab 的统计,源自这些函数。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/text-stats.ts` | `computeTextStats(s)` → `{ lines, words, chars }` 单遍纯函数 |

## 关键行为

- `lines`:`''` → 0;`'a'` → 1;`'a\nb'` → 2;尾部 \n 算空行
- `words`:`''` → 0;`'  '` → 0;按 `\s+` 切分
- `chars`:`''` → 0;返 `s.length`(UTF-16 code units,不严格等价 Unicode 字符)
