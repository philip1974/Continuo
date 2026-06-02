const FRONTMATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const WIKI_LINK_RE = /\[\[[^\]]+\]\]/;

/**
 * Syntax known to be unsafe for Milkdown/Crepe markdown round-tripping.
 *
 * v0.1 intentionally covers the reported corruption classes only:
 * YAML frontmatter and wiki-links. MDX, inline HTML, and custom directives
 * are not detected here; those remain protected by Source being the default
 * and Edit being an explicit opt-in.
 */
export function isMilkdownUnsafe(content: string): boolean {
  return FRONTMATTER_RE.test(content) || WIKI_LINK_RE.test(content);
}
