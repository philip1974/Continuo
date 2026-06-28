/**
 * Syntax known to be unsafe for Milkdown/Crepe markdown round-tripping.
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
  let lineStart = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (
    content.charCodeAt(lineStart) !== 45 ||
    content.charCodeAt(lineStart + 1) !== 45 ||
    content.charCodeAt(lineStart + 2) !== 45
  ) {
    return false;
  }

  lineStart = readLineBreak(content, lineStart + 3);
  if (lineStart < 0) return false;

  while (lineStart < content.length) {
    if (
      content.charCodeAt(lineStart) === 45 &&
      content.charCodeAt(lineStart + 1) === 45 &&
      content.charCodeAt(lineStart + 2) === 45 &&
      isFenceTerminated(content, lineStart + 3)
    ) {
      return true;
    }

    const nextLineStart = nextLine(content, lineStart);
    if (nextLineStart < 0) return false;
    lineStart = nextLineStart;
  }

  return false;
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
