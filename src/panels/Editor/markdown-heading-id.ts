// Markdown 编辑 / 预览(Milkdown)里标题的 id:与 `#片段` 链接解析同一套 GitHub slug(见 markdown-heading-slug)。
// BDD: src/__tests__/markdown-anchor-links/
//
// Milkdown 自带 syncHeadingIdPlugin(默认只小写 + 空格转 `-`,重复标题加 `-#2`)每次文档变化都深入行内遍历全文。这里:
// - 摘掉自带插件,由本插件独自同步;id 生成器换成「已有 id 优先,否则 GitHub slug」(toDOM 在同步前兜底用它);
// - 挂载时按文档顺序算全部标题(重复加 `-1`、`-2`…);之后只在变化范围触及标题(改名 / 增删 / 段落转标题)时,防抖到停手后
//   重算一次,不一致才改(不进撤销历史;输入法组字期间顺延)。正文里打字不遍历、不派发。
// id 只用于渲染出的 DOM(`#片段` 跳转按源码行定位,见 markdown-link-follow),短暂滞后不影响跳转。

import { headingIdGenerator, syncHeadingIdPlugin } from '@milkdown/kit/preset/commonmark';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { Editor } from '@milkdown/kit/core';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createSlugBuilder, githubSlug } from './markdown-heading-slug';

/** 标题改动后等多久(停手)再同步 id。 */
export const HEADING_ID_SYNC_DELAY_MS = 250;

/** 按文档顺序重算全部标题 id;只深入容器块(引用 / 列表),不进段落 / 代码块等文本块的行内内容。 */
function syncHeadingIds(view: EditorView): void {
  const slugOf = createSlugBuilder();
  const tr = view.state.tr;
  let changed = false;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return !node.isTextblock;
    const id = slugOf(node.textContent);
    if (node.attrs.id !== id) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
      changed = true;
    }
    return false;
  });
  if (changed) view.dispatch(tr.setMeta('addToHistory', false));
}

function hasHeadingBetween(doc: Node, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.type.name === 'heading') {
      found = true;
      return false;
    }
    return !node.isTextblock;
  });
  return found;
}

/** 两版文档的差异范围(新旧各一段)里有无标题。 */
function changeTouchesHeading(prev: Node, next: Node): boolean {
  const start = prev.content.findDiffStart(next.content);
  if (start === null) return false;
  const end = prev.content.findDiffEnd(next.content);
  const endA = Math.max(start, end?.a ?? prev.content.size);
  const endB = Math.max(start, end?.b ?? next.content.size);
  return hasHeadingBetween(prev, start, endA) || hasHeadingBetween(next, start, endB);
}

const headingIdPlugin = new Plugin({
  view: (view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let syncing = false;
    const run = (v: EditorView): void => {
      syncing = true;
      try {
        syncHeadingIds(v);
      } finally {
        syncing = false;
      }
    };
    const schedule = (v: EditorView): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (v.isDestroyed) return;
        if (v.composing) schedule(v);
        else run(v);
      }, HEADING_ID_SYNC_DELAY_MS);
    };
    if (view.composing) schedule(view);
    else run(view);
    return {
      update: (v, prev) => {
        if (syncing || v.state.doc.eq(prev.doc)) return;
        if (changeTouchesHeading(prev.doc, v.state.doc)) schedule(v);
      },
      destroy: () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    };
  },
});

/** 给 Crepe 的 editor 装上 GitHub slug 标题 id(创建前调用)。 */
export function installGithubHeadingIds(editor: Editor): void {
  editor.config((ctx) =>
    ctx.set(headingIdGenerator.key, (node: Node) => (node.attrs.id as string) || githubSlug(node.textContent)),
  );
  // 创建前摘除:Editor 尚未创建时 remove 同步删掉已登记的插件(Crepe 构造时 use 了 commonmark 预设)。
  void editor.remove(syncHeadingIdPlugin);
  editor.use($prose(() => headingIdPlugin));
}
