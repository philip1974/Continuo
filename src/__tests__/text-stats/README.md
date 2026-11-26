# text-stats(StatusBar 用统计)

行为契约:**字符串行数 / 词数 / 字符数**纯函数。
StatusBar 实时显示当前 active editor tab 的统计,源自这些函数。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/text-stats.ts` | `computeTextStats(s)` → `{ lines, words, chars }` 单遍纯函数 |

## 关键行为

- `lines`:与编辑器 CodeMirror `doc.lines` 一致(按 `/\r\n?|\n/` 切行):`''` → 1(空文件编辑器显示第 1 行,VSCode 同);`'a'` → 1;`'a\nb'` → 2;尾部换行算空行(`'a\n'` → 2);`\r\n` 计 1 个换行,孤立 `\r` 也计换行
- `words`:`''` → 0;`'  '` → 0;按 `\s+` 切分
- `chars`:与编辑器 CodeMirror `doc.length` 一致:`''` → 0;每个换行计 1 个字符 —— `\r\n` 计 1(crlf 文件不多算 `\r`),孤立 `\r` / `\n` 各计 1;其余按 UTF-16 code units(`'🌍'` = 2,不严格等价 Unicode 字符)
