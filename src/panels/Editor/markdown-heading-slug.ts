// Markdown 标题锚点:标题文字 → slug(渲染出的标题 id 与 `#片段` 链接解析共用;解析见 markdown-fragment)。
// BDD: src/__tests__/markdown-anchor-links/
//
// slug 规则对照 VSCode markdown 语言服务的 githubSlugifier(vscode-markdown-languageservice src/slugify.ts,抄自 github-slugger):
// 去首尾空白 → 小写 → 删去「字母 / 组合符 / 十进制数字 / 连接标点(_)/ 空格 / -」以外的字符(标点、符号、emoji、控制字符)→
// 空格换成 `-`。中文等 Unicode 字母保留。github-slugger 那张字符表按 Unicode 13 生成,这里用等价的 Unicode 属性写法
//(对 Unicode 13 已分配字符逐个核对一致;之后新分配的字符按其属性处理)。
// 重复标题:第 2 个起依次加 `-1`、`-2`…;加了后缀仍与已有的重名时继续递增(github-slugger 同;VSCode 的近似实现不查后缀重名)。

const SLUG_REMOVE = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu;

/** 标题文字 → slug(不含重复后缀)。 */
export function githubSlug(text: string): string {
  return text.trim().toLowerCase().replace(SLUG_REMOVE, '').replace(/\s/g, '-');
}

/** 按文档顺序给标题分配 slug(重复标题加 `-1`、`-2`…)。空标题(文字为空)不占 slug,返回 ''。 */
export function createSlugBuilder(): (text: string) => string {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return (text) => {
    if (text.trim() === '') return '';
    const base = githubSlug(text);
    let slug = base;
    let n = counts.get(base) ?? 0;
    while (used.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    counts.set(base, n);
    used.add(slug);
    return slug;
  };
}
