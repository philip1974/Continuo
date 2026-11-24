// 运行时读取当前生效的主题 token(--md-* 等 CSS 自定义属性)。
// 给不能写 CSS var 的消费者用(mermaid themeVariables、xterm 搜索装饰色等只收字面色值)。
// 事实来源与 ThemeProvider.applyThemeClass 一致:<html class="dark"> 上生效的计算值。

/**
 * 按 `{ 键: CSS 自定义属性名 }` 读取 `root` 上的计算值,返回 `{ 键: 值 }`。
 * `root` 缺省为 `document.documentElement`。
 * 任一 token 读不到(样式表未加载等)→ 返回 null,调用方整体退回自己的兜底配色,
 * 不拿残缺的一组值去拼。
 */
export function readThemeTokens<K extends string>(
  tokens: Readonly<Record<K, string>>,
  root?: Element,
): Record<K, string> | null {
  // 无 DOM(node 环境的单测 / 非渲染进程调用)→ 与读不到同等处理
  const el = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (el === null) return null;
  const style = getComputedStyle(el);
  const out = {} as Record<K, string>;
  for (const key of Object.keys(tokens) as K[]) {
    const value = style.getPropertyValue(tokens[key]).trim();
    if (value === '') return null;
    out[key] = value;
  }
  return out;
}
