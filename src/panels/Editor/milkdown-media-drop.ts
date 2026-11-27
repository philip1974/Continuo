// Markdown 编辑视图(Milkdown / ProseMirror)的粘贴 / 拖入(见 editor-media-drop;BDD: src/__tests__/markdown-image-paste/、
// src/__tests__/explorer-drag-out/):
// - 图片:替换 Crepe 的上传器 —— 它在没配 onUpload 时用 `URL.createObjectURL(file)`,文件里写进 `![](blob:…)`、图片没保存。
//   改为存成文档旁的图片(工作区内的磁盘文件直接引用)后插入指向它的相对路径;存不下来 → 提示、什么都不插。
// - 粘贴 / 拖入的 HTML 里 src 为 blob: / data: 的图片丢掉(存不下来的内嵌图片,不写进文档)。
// - 资源管理器拖来的文件:不插入 text/plain 的路径,事件留给 dockview 打开;⇧ 放下插入相对文档的链接(图片为图片节点)。
import type { UploadOptions } from '@milkdown/kit/plugin/upload';
import { Fragment, Slice, type Node as PmNode, type Schema } from '@milkdown/kit/prose/model';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, type EditorView } from '@milkdown/kit/prose/view';
import { t } from '@/i18n';
import { notify } from '@/notifications/notify';
import { hasExplorerDrag, readExplorerDragData } from '@/lib/explorer-drag';
import {
  defaultMediaStoreDeps,
  explorerDropFiles,
  markdownLinkTarget,
  storeImagesForDocument,
  takeImageFiles,
  type MarkdownLinkTarget,
  type MediaStoreDeps,
} from './editor-media-drop';

/** 编辑视图里插入的节点:图片 → image 节点(alt 留空:编辑视图里改不了 alt);其余 → 文件名文字带链接。 */
function nodesFor(schema: Schema, targets: readonly MarkdownLinkTarget[]): PmNode[] {
  const nodes: PmNode[] = [];
  targets.forEach((target, i) => {
    if (i > 0) nodes.push(schema.text(' '));
    if (target.image && schema.nodes['image']) {
      const node = schema.nodes['image'].createAndFill({ src: target.href, alt: '' });
      if (node) nodes.push(node);
      return;
    }
    const link = schema.marks['link'];
    nodes.push(schema.text(target.name, link ? [link.create({ href: target.href })] : []));
  });
  return nodes;
}

/** 替换 Crepe 上传器的配置(uploadConfig 的 update 函数)。documentPath 取值时读。 */
export function markdownImageUploadConfig(
  documentPath: () => string | null,
  deps: MediaStoreDeps = defaultMediaStoreDeps,
): (prev: UploadOptions) => UploadOptions {
  return (prev) => ({
    ...prev,
    uploader: async (files, schema) => {
      const images = takeImageFiles(files);
      const doc = documentPath();
      const stored = await storeImagesForDocument(doc, images, deps);
      if (doc === null) return [];
      return nodesFor(schema, stored.map((p) => markdownLinkTarget(doc, p, true)));
    },
    uploadWidgetFactory: (pos, spec) => {
      const el = document.createElement('span');
      el.className = 'continuo-upload-placeholder';
      el.textContent = t('editor.media.saving_image');
      return Decoration.widget(pos, el, spec);
    },
  });
}

const INLINE_IMAGE_SRC = /^\s*(?:blob|data):/i;

/** 去掉切片里 src 为 blob: / data: 的图片节点;没有则原样返回。 */
function withoutInlineImages(fragment: Fragment): { fragment: Fragment; removed: boolean } {
  let removed = false;
  const children: PmNode[] = [];
  fragment.forEach((child) => {
    if (child.type.name === 'image' && INLINE_IMAGE_SRC.test(String(child.attrs['src'] ?? ''))) {
      removed = true;
      return;
    }
    if (child.content.size > 0) {
      const inner = withoutInlineImages(child.content);
      if (inner.removed) {
        removed = true;
        children.push(child.copy(inner.fragment));
        return;
      }
    }
    children.push(child);
  });
  return removed ? { fragment: Fragment.from(children), removed } : { fragment, removed };
}

/** ProseMirror 插件:粘贴 / 拖入切片的内嵌图片过滤 + 资源管理器拖放(见文件头)。 */
export function markdownMediaDropPlugin(documentPath: () => string | null): Plugin {
  return new Plugin({
    props: {
      transformPasted(slice) {
        const { fragment, removed } = withoutInlineImages(slice.content);
        if (!removed) return slice;
        notify.warn(t('editor.media.inline_image_skipped'));
        return new Slice(fragment, slice.openStart, slice.openEnd);
      },
      handleDOMEvents: {
        drop(view: EditorView, event: DragEvent) {
          if (!hasExplorerDrag(event.dataTransfer)) return false;
          // 代码块里的 CodeMirror 已处理(它先收到事件,见 codemirror-media-drop)
          if (event.defaultPrevented) return true;
          event.preventDefault(); // 不插入 text/plain 的路径;不阻止冒泡 —— dockview 接着打开文件
          const doc = documentPath();
          if (!event.shiftKey || !view.editable || doc === null) return true;
          const files = explorerDropFiles(readExplorerDragData(event.dataTransfer)?.entries ?? []);
          if (files.length === 0) return true;
          let pos = view.state.selection.from;
          try {
            pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? pos;
          } catch {
            /* 取不到落点(布局未就绪):插在光标处 */
          }
          const nodes = nodesFor(view.state.schema, files.map((p) => markdownLinkTarget(doc, p)));
          view.focus();
          view.dispatch(view.state.tr.replaceRange(pos, pos, new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView());
          return true;
        },
      },
    },
  });
}
