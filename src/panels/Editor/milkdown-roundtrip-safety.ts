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
  return hasYamlFrontmatter(content) || hasWikiLink(content);
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
