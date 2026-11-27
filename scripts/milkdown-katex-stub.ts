// @milkdown/crepe 的 katex 空壳(由 vite-milkdown-katex-stub 插件替换 @milkdown 内的 `import katex from 'katex'`)。
// Crepe 只用默认导出的 render(code, dom, opts)(行内公式 toDOM)与 renderToString(content, opts)(latex 代码块预览)。
// 两处都被 src/panels/Editor/milkdown-math.ts 覆盖(math_inline schema 重注册、renderPreview 先行拦截),改由懒加载的
// katex-render 渲染,故这里不可达。⚠ 去掉 configureMarkdownMath 前须先移除本空壳与插件,否则公式渲染为空。
const katexStub = {
  render(): void {},
  renderToString(): string {
    return '';
  },
};

export default katexStub;
