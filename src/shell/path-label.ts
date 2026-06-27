// shell chrome(TitleBar / StatusBar)路径展示名(可维护性 M11:消除两处复制)。
//
// 取路径最后一段(同时吃 `/` 与 `\`),匹配不到分隔后缀则返回原串。用于 workspace /
// active file 在标题栏 / 状态栏的展示名。
//
// 注:与 Explorer 的 `path-utils.basename` 实现不同(这里**不** trim 尾部分隔符;
// Explorer 版先 trim 再取段),刻意单独命名 `basenameForChrome` 避免两层
// chrome/文件树规则被误合并。
export function basenameForChrome(p: string): string {
  let lastSep = -1;
  for (let i = p.length - 1; i >= 0; i--) {
    const ch = p.charCodeAt(i);
    if (ch === 47 || ch === 92) {
      lastSep = i;
      break;
    }
  }
  if (lastSep < 0) return p;
  if (lastSep === p.length - 1) return p;
  return p.slice(lastSep + 1);
}
