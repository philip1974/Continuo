// Markdown 源码模式(CodeMirror):Cmd/Ctrl+click 链接跳转(VSCode Markdown 文档链接同;编辑 / 预览模式见 MilkdownEditor)。
// 按 lang-markdown 语法树取链接地址:`[文字](地址)`、`![alt](地址)`、`<地址>` 自动链接、裸 URL;引用式链接等无地址的不处理。
// 命中链接时吞掉这次按下(不移动光标;添加光标是 ⌥ 单击,见 editor-mouse-multicursor),地址交给 onLink(EditorPanel 的 resolveLink 路由)。
// BDD: src/__tests__/markdown-anchor-links/

import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';

/** pos 处的 Markdown 链接地址;不在链接上 → null。 */
export function markdownLinkHrefAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Link' || node.name === 'Image' || node.name === 'Autolink') {
        const url = node.getChild('URL');
        if (!url) return null;
        return unwrap(state.sliceDoc(url.from, url.to));
      }
      if (node.name === 'URL') return unwrap(state.sliceDoc(node.from, node.to)); // 裸 URL(GFM 自动链接)
      if (node.name === 'Paragraph' || node.name === 'Document') break;
    }
  }
  return null;
}

function unwrap(url: string): string | null {
  const s = url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
  return s === '' ? null : s;
}

/** Cmd/Ctrl+click 链接 → onLink(href)。getOnLink 每次取最新回调(未给 → 不处理)。 */
export function markdownLinkClickExtension(getOnLink: () => ((href: string) => void) | undefined): Extension {
  return EditorView.domEventHandlers({
    mousedown: (e, view) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
      const onLink = getOnLink();
      if (!onLink) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      const href = markdownLinkHrefAt(view.state, pos);
      if (href === null) return false;
      e.preventDefault();
      onLink(href);
      return true;
    },
  });
}
