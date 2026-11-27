/**
 * Syntax known to be unsafe for Milkdown/Crepe markdown round-tripping.
 *
 * Fenced code blocks (including ```mermaid diagrams) round-trip unchanged and
 * are deliberately not flagged.
 *
 * Covers the reported corruption classes: YAML frontmatter, wiki-links, math
 * (`$…$` / `$$…$$`: Milkdown has no math nodes without the Latex feature, so
 * `x_1` / `\,` / `\{` inside are escaped or lose their backslash), and
 * reference-style link definitions (`[ref]: url` — Milkdown inlines
 * `[text][ref]` and drops the definition). MDX, inline HTML, and custom
 * directives are not detected here; those remain protected by Source being
 * the default and Edit being an explicit opt-in.
 */
export function isMilkdownUnsafe(content: string): boolean {
  // wiki-link / 引用定义只看正文:围栏代码块 / 行内代码里的 `[[`(TOML `[[bin]]`、bash `if [[ … ]]`)原样往返,不是 wiki-link。
  if (hasYamlFrontmatter(content)) return true;
  const body = stripCode(content);
  return hasWikiLink(body) || hasLinkDefinition(body) || hasMath(stripCode(content, true));
}

/*
 * 去掉围栏代码块后的正文,只用于 wiki-link / 引用定义 / 公式判定。误差只许偏向「不安全」(多锁 Source 无害;把真实 wiki-link 当代码
 * 藏掉 → 判安全 → Milkdown 往返破坏数据)。按行猜 CommonMark 块结构处处有反例(列表 / 引用 / HTML 块 / 缩进闭栏 /
 * 跨行行内代码),故只认可证明的形态,其余一律不剥:
 *  - 全文出现缩进的围栏样行、行首 `<`(HTML 块,类型 1-5 可跨空行)或 `$$`(数学块可跨空行)→ 整篇不剥。
 *    公式判定(`mathLinesOk`)不因 `$$` 行放弃:要藏住一个数学块,其开头的 `$$` 须落在被剥掉的围栏里,而第 0 列的围栏行
 *    只有在更早的数学块里才不是围栏 —— 那个更早的 `$$` 不会被剥,照样判出公式。
 *  - 第 0 列的围栏行总在顶层开栏(可打断段落;列表项 / 引用的延续对非段落行不生效;第 0 列非空行结束缩进代码),
 *    闭栏同字符、不短于开栏、第 0 列(全文无缩进围栏样行,故不会漏认缩进闭栏);未闭合不剥。
 *  - 行内代码不剥(同段落可跨行,按行配对会把正文当代码);公式判定在 hasMath 里按行跳过行内代码。
 * 单遍扫描,线性(每次按键都会判定)。
 */
const FENCE_LIKE_INDENTED = /^[ \t]+(?:`{3,}|~{3,})/;
const HTML_OR_MATH_LINE = /^ {0,3}(?:<|\$\$)/;
const HTML_LINE = /^ {0,3}</;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

function stripCode(content: string, mathLinesOk = false): string {
  if (!content.includes('```') && !content.includes('~~~')) return content;
  const bail = mathLinesOk ? HTML_LINE : HTML_OR_MATH_LINE;
  // 文首 BOM 被 CommonMark 预处理丢弃:不去掉则第 0 行的围栏认不出,后续开闭栏整体错位(把正文当代码)。
  const lines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (FENCE_LIKE_INDENTED.test(line) || bail.test(line)) return content;
  }
  let open: { readonly at: number; readonly ch: string; readonly len: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (open) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len) {
        for (let k = open.at; k <= i; k += 1) lines[k] = '';
        open = null;
      }
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (!m) continue;
    const run = m[1]!;
    if (run[0] === '`' && m[2]!.includes('`')) continue; // 反引号围栏的 info 不得含反引号(那是行内代码)
    open = { at: i, ch: run[0]!, len: run.length };
  }
  return lines.join('\n'); // 未闭合的 open 原样保留(保守)
}

function hasYamlFrontmatter(content: string): boolean {
  return findYamlFrontmatter(content) !== null;
}

export interface FrontmatterRange {
  /** YAML 正文起点(开栏 `---` 行之后). */
  readonly bodyStart: number;
  /** 闭栏 `---` 行的起点. */
  readonly bodyEnd: number;
  /** 闭栏行(含换行)之后的第一个字符. */
  readonly end: number;
}

export function findYamlFrontmatter(content: string): FrontmatterRange | null {
  let lineStart = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (
    content.charCodeAt(lineStart) !== 45 ||
    content.charCodeAt(lineStart + 1) !== 45 ||
    content.charCodeAt(lineStart + 2) !== 45
  ) {
    return null;
  }

  lineStart = readLineBreak(content, lineStart + 3);
  if (lineStart < 0) return null;
  const bodyStart = lineStart;

  while (lineStart < content.length) {
    if (
      content.charCodeAt(lineStart) === 45 &&
      content.charCodeAt(lineStart + 1) === 45 &&
      content.charCodeAt(lineStart + 2) === 45 &&
      isFenceTerminated(content, lineStart + 3)
    ) {
      const afterFence = lineStart + 3;
      return {
        bodyStart,
        bodyEnd: lineStart,
        end:
          afterFence === content.length
            ? afterFence
            : readLineBreak(content, afterFence),
      };
    }

    const nextLineStart = nextLine(content, lineStart);
    if (nextLineStart < 0) return null;
    lineStart = nextLineStart;
  }

  return null;
}

/**
 * Preview 专用的展示变换:把文首 YAML frontmatter 换成 `yaml` 围栏代码块。
 * CommonMark 会把 frontmatter 解析成「分隔线 + setext 标题」,只读预览里直接喂给
 * Milkdown 会显示成一条横线加一个大标题。Preview 不写回 store,所以这里只影响显示,
 * 文件内容不变。
 */
export function toPreviewMarkdown(content: string): string {
  const range = findYamlFrontmatter(content);
  if (!range) return content;
  const yaml = content
    .slice(range.bodyStart, range.bodyEnd)
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  // 围栏须比正文里最长的反引号串更长,否则正文里的 ``` 会提前闭合代码块。
  let fence = '```';
  while (yaml.includes(fence)) fence += '`';
  return `${fence}yaml\n${yaml === '' ? '' : `${yaml}\n`}${fence}\n\n${content.slice(range.end)}`;
}

function readLineBreak(content: string, index: number): number {
  if (content.charCodeAt(index) === 13) {
    return content.charCodeAt(index + 1) === 10 ? index + 2 : -1;
  }
  return content.charCodeAt(index) === 10 ? index + 1 : -1;
}

function isFenceTerminated(content: string, index: number): boolean {
  return index === content.length || readLineBreak(content, index) >= 0;
}

function nextLine(content: string, index: number): number {
  for (let i = index; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) return i + 1;
  }
  return -1;
}

function hasWikiLink(content: string): boolean {
  let start = content.indexOf('[[', 0);
  while (start >= 0) {
    const bodyStart = start + 2;
    for (let i = bodyStart; i < content.length; i += 1) {
      if (content.charCodeAt(i) !== 93) continue;
      if (i > bodyStart && content.charCodeAt(i + 1) === 93) return true;
      break;
    }
    start = content.indexOf('[[', bodyStart);
  }
  return false;
}

/*
 * 引用式链接定义 `[label]: destination`(可在引用 / 列表项里;GFM 脚注 `[^1]:` 有对应节点,不算)。只认行首形态,
 * 段落中间同形的行(定义不能打断段落)也判不安全 —— 误差偏向「不安全」。
 */
const LINK_DEFINITION = /^ {0,3}(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*\[(?!\^)(?:[^\]\\\r\n]|\\.)+\]:/;

function hasLinkDefinition(content: string): boolean {
  if (!content.includes(']:')) return false;
  for (const line of content.split(/\r\n|\n|\r/)) {
    if (line.includes(']:') && LINK_DEFINITION.exec(line) !== null) return true;
  }
  return false;
}

/*
 * 公式(remark-math:`$…$` 行内、`$$…$$` 行内或成块)。识别规则:
 *  - 行内代码里的 `$` 不算(反引号串配同长的反引号串,按行配对:跨行的行内代码不剥 → 偏向「不安全」);`\$` 不算。
 *  - 两个及以上连续的 `$`(`$$`)一律算公式(块公式可跨空行,不配对)。
 *  - 单个 `$`:同一段落(不跨空行)里按 Pandoc / Obsidian 规则配对 —— 开头的 `$` 后面不是空白,结尾的 `$` 前面不是空白、
 *    后面不是数字。`$5`、`$5 and $10`、`$5-$10` 这类金额不配对,不算(remark-math 本身会把 `$5 and $10` 当公式,
 *    但那段文字里不含会被改写的 `_` / `\` 之类,往返不坏)。
 * 一个开头 `$` 找不到结尾时,本段之后的开头也都找不到(结尾条件与开头无关)→ 本段只剩找 `$$`,整体线性。
 */
function hasMath(content: string): boolean {
  if (!content.includes('$')) return false;
  for (const block of content.split(/(?:\r\n|\n|\r)[ \t]*(?=\r\n|\n|\r)/)) {
    if (block.includes('$') && blockHasMath(block)) return true;
  }
  return false;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || Number.isNaN(code);
}

function blockHasMath(s: string): boolean {
  let pairable = true; // 单个 `$` 还可能配对
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      i += 2; // 反斜杠转义(代码外)
      continue;
    }
    if (c === 96) {
      let n = 1;
      while (s.charCodeAt(i + n) === 96) n += 1;
      const close = findBacktickClose(s, i + n, n);
      i = close < 0 ? i + n : close;
      continue;
    }
    if (c !== 36) {
      i += 1;
      continue;
    }
    if (s.charCodeAt(i + 1) === 36) return true;
    if (pairable && !isSpace(s.charCodeAt(i + 1))) {
      for (let j = i + 2; j < s.length; j += 1) {
        if (s.charCodeAt(j) !== 36) continue;
        if (s.charCodeAt(j + 1) === 36) return true;
        const prev = s.charCodeAt(j - 1);
        const next = s.charCodeAt(j + 1);
        if (!isSpace(prev) && prev !== 92 && !(next >= 48 && next <= 57)) return true;
      }
      pairable = false;
    }
    i += 1;
  }
  return false;
}

/** 从 `from` 起在同一行里找恰好 `n` 个反引号的串,返回其后位置;没有 → -1。 */
function findBacktickClose(s: string, from: number, n: number): number {
  let i = from;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) return -1;
    if (c !== 96) {
      i += 1;
      continue;
    }
    let m = 1;
    while (s.charCodeAt(i + m) === 96) m += 1;
    if (m === n) return i + m;
    i += m;
  }
  return -1;
}
