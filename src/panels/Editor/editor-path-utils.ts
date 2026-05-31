export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
}
