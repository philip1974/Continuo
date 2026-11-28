// Markdown 编辑模式(Milkdown)的粘贴(BDD: src/__tests__/editor-clipboard/):
//  - 粘贴前后各断开撤销(VSCode 粘贴 shouldPushStackElementBefore / After;prosemirror-history 默认把 500ms 内相邻的改动并成一组,
//    粘贴后紧接着打字会与粘贴一起被撤销)。粘贴事件开始时断一次;粘贴处理(剪贴板插件 / 加链接 / 默认粘贴)都是同步派发,
//    事件结束后的微任务里再断一次。
//  - 从代码编辑器复制来的内容(带 EDITOR_CLIPBOARD_MIME):照旧按纯文本当 Markdown 解析,不用随附的语法高亮 HTML ——
//    否则从源码模式复制的 `# 标题` 粘回编辑模式成了普通段落。
//  - 粘贴网页 HTML:图片的 title 只取 title 属性(上游 preset-commonmark 缺省回落到 alt,保存成 `![x](a.png "x")`);
//    代码块语言按常见网页约定取(`<pre data-language>` / `data-lang`、`<code class="language-*">` / `lang-*`),此前只认
//    Milkdown 自己的 data-language,别处的代码块语言丢失。只认语言名形状的值(字母数字与 + # . - _),其余忽略。

import type { Ctx } from '@milkdown/kit/ctx';
import { parserCtx, schemaCtx } from '@milkdown/kit/core';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import { isTextOnlySlice } from '@milkdown/kit/prose';
import { closeHistory } from '@milkdown/kit/prose/history';
import { DOMParser, DOMSerializer, type Slice } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { EDITOR_CLIPBOARD_MIME } from './codemirror-clipboard';

/** 粘贴前后断开撤销的 ProseMirror 插件。 */
export function createPasteHistoryPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('continuoPasteHistory'),
    props: {
      handleDOMEvents: {
        paste: (view) => {
          if (!view.editable) return false;
          view.dispatch(closeHistory(view.state.tr));
          queueMicrotask(() => {
            if (!view.isDestroyed) view.dispatch(closeHistory(view.state.tr));
          });
          return false;
        },
      },
    },
  });
}

export const pasteHistoryBoundary = $prose(() => createPasteHistoryPlugin());

function dispatchSlice(view: EditorView, slice: Slice): boolean {
  // 同 @milkdown/plugin-clipboard dispatchPasteSlice:无格式的单段纯文本 → 插入文字节点;否则替换选区
  const node = isTextOnlySlice(slice);
  if (node) {
    view.dispatch(view.state.tr.replaceSelectionWith(node, true));
    return true;
  }
  try {
    view.dispatch(view.state.tr.replaceSelection(slice));
    return true;
  } catch {
    return false;
  }
}

/** 粘贴的是代码编辑器复制的内容 → 按纯文本解析成 Markdown 插入(handlePaste;不归自己 → false)。 */
export function pasteEditorCopyAsMarkdown(ctx: Ctx, view: EditorView, event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  if (!data || !view.editable || data.getData(EDITOR_CLIPBOARD_MIME) === '') return false;
  if (view.state.selection.$from.node().type.spec.code) return false; // 代码块里:交给默认粘贴(纯文本)
  const text = data.getData('text/plain');
  if (text === '') return false;
  const doc = ctx.get(parserCtx)(text);
  if (!doc || typeof doc === 'string') return false;
  const schema = ctx.get(schemaCtx);
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
  return dispatchSlice(view, DOMParser.fromSchema(schema).parseSlice(dom));
}

const LANGUAGE_NAME = /^[\w+#.-]{1,64}$/;

function languageToken(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && LANGUAGE_NAME.test(v) ? v : null;
}

function classLanguage(el: Element | null): string | null {
  if (!el) return null;
  for (const cls of Array.from(el.classList)) {
    const m = /^(?:language|lang)-(.+)$/.exec(cls);
    const lang = m ? languageToken(m[1]) : null;
    if (lang) return lang;
  }
  return null;
}

/** 网页 `<pre>` 代码块的语言(纯函数;取不到 → '')。 */
export function codeBlockLanguageFromDom(pre: HTMLElement): string {
  const code = pre.querySelector(':scope > code');
  return (
    languageToken(pre.dataset.language) ??
    languageToken(pre.getAttribute('data-lang')) ??
    languageToken(code?.getAttribute('data-language')) ??
    languageToken(code?.getAttribute('data-lang')) ??
    classLanguage(code) ??
    classLanguage(pre) ??
    ''
  );
}

/** 图片 parseDOM:title 只取 title 属性(不回落到 alt)。 */
export const imagePasteSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return false;
          return {
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            title: dom.getAttribute('title') || '',
          };
        },
      },
    ],
  };
});
