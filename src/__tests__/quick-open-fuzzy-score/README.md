# Quick Open 文件打分(VSCode fuzzyScorer 对齐)

VSCode ⌘P(anythingQuickAccess)用 `src/vs/base/common/fuzzyScorer.ts` 的 `prepareQuery` + `scoreItemFuzzy` +
`compareItemsByFuzzyScore` 给文件打分排序:先对文件名(label)打分 —— 完整一致 / 前缀命中最高、短文件名优先、连续命中加分;
文件名不命中再对「目录 + 分隔符 + 文件名」打分;查询按空格拆成多段,每段都要命中。旧实现对整条相对路径做贪心最左子序列,
输入完整文件名(`CodeEditor.tsx`)时往往排不到第一,多个词(`quick open`)要求路径里真有空格、几乎搜不到。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/fuzzy-scorer.ts` | VSCode fuzzyScorer 移植(MIT,注明来源):`scoreFuzzy` / `prepareQuery` / `scoreItemFuzzy` / `compareItemScores` |
| `src/plugins/quick-open/quick-open-filter.ts` | Quick Open 候选 → 打分、排序(同分「最近打开」优先)、命中区段(行高亮) |

## 行为(`quick-open-fuzzy-score.spec.ts`)

- 输入完整文件名:该文件排第一(胜过路径里散落着这些字符的长路径,如 `editor-tab-git.spec.tsx`)
- 输入文件名的一部分(不分大小写,如 `codeeditor`):文件名前缀命中的排在前;同前缀时短文件名在前
- 多个同名文件(`index.ts`):路径更短的在前
- 查询含 `/`:按「目录 / 文件名」打分(`quick-open/store` 命中 `src/plugins/quick-open/store.ts`)
- 查询按空格拆段、每段都要命中,段的顺序无关(`quick open` / `open quick` 都命中 `QuickOpenModal.tsx`);任一段不命中 → 不显示
- 同分时「最近打开」的文件在前(Continuo 既有加权)
- 命中区段分别落在文件名 / 目录上(列表行高亮用)
- 有查询时最多列出 512 个分数最高的结果(VSCode `AnythingQuickAccessProvider.MAX_RESULTS` + `arrays.top`,免对数万条全排序)

## 命令面板

VSCode 命令面板不用 fuzzyScorer,而是 `or(matchesBaseContiguousSubString, matchesWords)`(按词首匹配、查询里的空格匹配
目标里的任意分隔符,不按空格拆段)。Continuo 命令面板的子序列匹配里空格同样匹配标题中的空格(`quick open` 命中
「Quick Open」类命令),本轮不替换。
