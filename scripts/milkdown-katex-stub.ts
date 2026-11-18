// @milkdown/crepe 的 katex 空壳(由 vite-milkdown-katex-stub 插件替换 @milkdown 内的 `import katex from 'katex'`)。
// Crepe 只用默认导出的 render(code, dom, opts) 与 renderToString(content, opts),且仅在
// CrepeFeature.Latex 启用时可达(数学 schema / 输入规则 / toolbar 公式按钮都按该 flag 注册)。
// ⚠ 启用 CrepeFeature.Latex 前须移除本空壳与插件,否则公式渲染为空。
const katexStub = {
  render(): void {},
  renderToString(): string {
    return '';
  },
};

export default katexStub;
