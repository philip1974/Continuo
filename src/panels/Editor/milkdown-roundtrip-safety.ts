/**
 * Syntax known to be unsafe for Milkdown/Crepe markdown round-tripping.
 *
 * Fenced code blocks (including ```mermaid diagrams) round-trip unchanged and
 * are deliberately not flagged.
 *
 * v0.1 intentionally covers the reported corruption classes only:
 * YAML frontmatter and wiki-links. MDX, inline HTML, and custom directives
 * are not detected here; those remain protected by Source being the default
 * and Edit being an explicit opt-in.
 */
export function isMilkdownUnsafe(content: string): boolean {
  // wiki-link 只看正文:围栏代码块 / 行内代码里的 `[[`(TOML `[[bin]]`、bash `if [[ … ]]`)原样往返,不是 wiki-link。
  return hasYamlFrontmatter(content) || hasWikiLink(stripCode(content));
}

/*
 * 去掉围栏代码块后的正文,只用于 wiki-link 判定。误差只许偏向「不安全」(多锁 Source 无害;把真实 wiki-link 当代码
 * 藏掉 → 判安全 → Milkdown 往返破坏数据)。按行猜 CommonMark 块结构处处有反例(列表 / 引用 / HTML 块 / 缩进闭栏 /
 * 跨行行内代码),故只认可证明的形态,其余一律不剥:
 *  - 全文出现缩进的围栏样行、行首 `<`(HTML 块,类型 1-5 可跨空行)或 `$$`(数学块可跨空行)→ 整篇不剥。
 *  - 第 0 列的围栏行总在顶层开栏(可打断段落;列表项 / 引用的延续对非段落行不生效;第 0 列非空行结束缩进代码),
 *    闭栏同字符、不短于开栏、第 0 列(全文无缩进围栏样行,故不会漏认缩进闭栏);未闭合不剥。
 *  - 行内代码不剥(同段落可跨行,按行配对会把正文当代码)。
 * 单遍扫描,线性(每次按键都会判定)。
 */
const FENCE_LIKE_INDENTED = /^[ \t]+(?:`{3,}|~{3,})/;
const HTML_OR_MATH_LINE = /^ {0,3}(?:<|\$\$)/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

function stripCode(content: string): string {
  if (!content.includes('```') && !content.includes('~~~')) return content;
  // 文首 BOM 被 CommonMark 预处理丢弃:不去掉则第 0 行的围栏认不出,后续开闭栏整体错位(把正文当代码)。
  const lines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (FENCE_LIKE_INDENTED.test(line) || HTML_OR_MATH_LINE.test(line)) return content;
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

interface FrontmatterRange {
  /** YAML 正文起点(开栏 `---` 行之后). */
  readonly bodyStart: number;
  /** 闭栏 `---` 行的起点. */
  readonly bodyEnd: number;
  /** 闭栏行(含换行)之后的第一个字符. */
  readonly end: number;
}

function findYamlFrontmatter(content: string): FrontmatterRange | null {
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
