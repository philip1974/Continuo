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
 * 去掉代码后的正文,只用于 wiki-link 判定。误差只许偏向「不安全」(多锁 Source 无害;把真实 wiki-link 当代码藏掉 →
 * 判安全 → Milkdown 往返破坏数据)。故只认确定无歧义的形态,其余保留原文:
 *  - 围栏:开栏与闭栏都在第 0 列(不在列表 / 引用 / 缩进内),且找得到闭栏;未闭合不剥。
 *  - 行内代码:只在同一行内配对(不跨块边界:列表项 / 标题 / 段落);开栏不得被反斜杠转义;含 `<`(自动链接 / HTML
 *    优先于代码片段)或 `|`(表格单元格先于代码片段切分)的行不剥。线性扫描,无回溯。
 */
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

function stripCode(content: string): string {
  if (!content.includes('`') && !content.includes('~~~')) return content;
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open) continue;
    const run = open[1]!;
    if (run[0] === '`' && open[2]!.includes('`')) continue; // 反引号围栏的 info 不得含反引号
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = FENCE_CLOSE.exec(lines[j]!);
      if (m && m[1]![0] === run[0] && m[1]!.length >= run.length) {
        close = j;
        break;
      }
    }
    if (close < 0) continue; // 未闭合:保守不剥
    for (let k = i; k <= close; k += 1) lines[k] = '';
    i = close;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.includes('`') && line.includes('[[') && !line.includes('<') && !line.includes('|')) {
      lines[i] = stripInlineCode(line);
    }
  }
  return lines.join('\n');
}

/** 同一行内的行内代码片段(等长反引号串成对,开栏未被转义)→ 删去。O(n)。 */
function stripInlineCode(line: string): string {
  const runs: { start: number; len: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line.charCodeAt(i) !== 96) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line.charCodeAt(j) === 96) j += 1;
    runs.push({ start: i, len: j - i });
    i = j;
  }
  // nextSame[k]:k 之后第一个同长度反引号串的下标。
  const nextSame = new Array<number>(runs.length).fill(-1);
  const lastByLen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k -= 1) {
    nextSame[k] = lastByLen.get(runs[k]!.len) ?? -1;
    lastByLen.set(runs[k]!.len, k);
  }
  let out = '';
  let pos = 0;
  for (let k = 0; k < runs.length; k += 1) {
    const r = runs[k]!;
    if (r.start < pos) continue;
    let backslashes = 0;
    for (let b = r.start - 1; b >= 0 && line.charCodeAt(b) === 92; b -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue; // 转义:字面反引号,不开栏
    const c = nextSame[k]!;
    if (c < 0) continue;
    out += line.slice(pos, r.start);
    pos = runs[c]!.start + runs[c]!.len;
    k = c;
  }
  return out + line.slice(pos);
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
