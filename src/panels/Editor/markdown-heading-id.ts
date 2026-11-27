// Markdown 编辑 / 预览(Milkdown)里标题的 id:与 `#片段` 链接解析同一套 GitHub slug(见 markdown-heading-slug)。
// BDD: src/__tests__/markdown-anchor-links/
//
// Milkdown 自带 syncHeadingIdPlugin(默认只小写 + 空格转 `-`,重复标题加 `-#2`)。这里:
// - id 生成器换成「已有 id 优先,否则 GitHub slug」—— 自带插件据此算出的就是本插件写下的 id,不再改回;
// - 本插件在文档变化后按文档顺序重算全部标题(重复加 `-1`、`-2`…),不一致才改(不进撤销历史;输入法组字期间不改)。
// 自带插件的初次计算若与此不同,本插件随即改正一次,之后两者一致。

import { headingIdGenerator } from '@milkdown/kit/preset/commonmark';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { Editor } from '@milkdown/kit/core';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createSlugBuilder, githubSlug } from './markdown-heading-slug';

function syncHeadingIds(view: EditorView): void {
  if (view.composing) return;
  const slugOf = createSlugBuilder();
  const tr = view.state.tr;
  let changed = false;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    const id = slugOf(node.textContent);
    if (node.attrs.id !== id) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
      changed = true;
    }
    return false;
  });
  if (changed) view.dispatch(tr.setMeta('addToHistory', false));
}

const headingIdPlugin = new Plugin({
  view: (view) => {
    syncHeadingIds(view);
    return {
      update: (v, prev) => {
        if (!v.state.doc.eq(prev.doc)) syncHeadingIds(v);
      },
    };
  },
});

/** 给 Crepe 的 editor 装上 GitHub slug 标题 id(创建前调用)。 */
export function installGithubHeadingIds(editor: Editor): void {
  editor.config((ctx) =>
    ctx.set(headingIdGenerator.key, (node: Node) => (node.attrs.id as string) || githubSlug(node.textContent)),
  );
  editor.use($prose(() => headingIdPlugin));
}
