import { lastSeparatorIndex } from './path-cross';

// 路径展示名(TitleBar / StatusBar / Explorer 最近打开列表共用;可维护性 M11:消除复制)。
//
// 取路径最后一段(`/`;Windows 上另吃 `\`),匹配不到分隔后缀则返回原串。用于 workspace /
// active file 在标题栏 / 状态栏的展示名,以及最近打开 root 的名称。
//
// 注:与 Explorer 的 `path-utils.basename` 实现不同(这里**不** trim 尾部分隔符;
// Explorer 版先 trim 再取段),刻意单独命名 `basenameForChrome` 避免两层
// chrome/文件树规则被误合并。
// macOS / Linux 上 `\` 是合法文件名字符,不当分隔符(见 path-cross.lastSeparatorIndex)。
export function basenameForChrome(p: string): string {
  const lastSep = lastSeparatorIndex(p);
  if (lastSep < 0) return p;
  if (lastSep === p.length - 1) return p;
  return p.slice(lastSep + 1);
}
