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

/** 围栏 ``` / ~~~ 的开栏(行首至多 3 空格,≥3 个同一字符;``` 的 info 不得含反引号)。返回 [字符, 长度] 或 null。 */
function openingFence(line: string): readonly [string, number] | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const run = m[1]!;
  if (run[0] === '`' && m[2]!.includes('`')) return null;
  return [run[0]!, run.length];
}

function isClosingFence(line: string, ch: string, len: number): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1]![0] === ch && m[1]!.length >= len;
}

/** 去掉围栏代码块(未闭合则延续到文末,同 CommonMark)与行内代码片段(等长反引号串成对)后的正文。 */
function stripCode(content: string): string {
  if (!content.includes('`') && !content.includes('~~~')) return content;
  const lines = content.split('\n');
  const kept: string[] = [];
  let fence: readonly [string, number] | null = null;
  for (const line of lines) {
    if (fence) {
      if (isClosingFence(line.replace(/\r$/, ''), fence[0], fence[1])) fence = null;
      kept.push('');
      continue;
    }
    fence = openingFence(line.replace(/\r$/, ''));
    kept.push(fence ? '' : line);
  }
  // 行内代码不跨空行(段落边界):否则一个孤立反引号会与后面段落的反引号配对,把其间真实的 wiki-link 藏掉 → 误判安全、
  // 往返破坏。开栏须是完整反引号串(前后都不是反引号),闭栏等长。
  return kept.join('\n').replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g, '');
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
