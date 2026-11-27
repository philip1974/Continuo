// CodeMirror(代码文件 / Markdown 源码视图 / Markdown 编辑视图里的代码块)的拖放与粘贴(见 editor-media-drop;
// BDD: src/__tests__/explorer-drag-out/、src/__tests__/markdown-image-paste/):
// - 资源管理器拖来的文件:不按 text/plain 插入路径(CodeMirror 内建 drop 会)—— 事件留给 dockview 打开;⇧ 放下才插入
//   (Markdown 源码:相对文档的链接;其余:相对工作区根的路径)。
// - Markdown 源码视图:粘贴截图 / 拖入图片文件 → 存成文档旁的图片后插入 `![alt text](相对路径)`,选中 alt 占位(VSCode 片段同)。
//   存图是异步的:插入位置随期间的编辑映射。剪贴板里有文字时照常粘贴文字(VSCode:图片插入让位于文本粘贴)。
// - 从 Finder 拖来的其它磁盘文件(BDD: src/__tests__/os-file-drop/):绝不走 CodeMirror 内建 drop(它读出文件内容插进文档);
//   不按 ⇧ → 留给编辑器面板打开(os-file-drop);⇧ → 插入(Markdown:相对文档的链接;其余:路径),并认领这些文件不再打开。
import { StateEffect, StateField, EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { hasExplorerDrag, readExplorerDragData } from '@/lib/explorer-drag';
import { MAX_DROP_FILES, captureDroppedRegularFiles, claimDroppedFiles } from '@/lib/window-drop';
import {
  codeDropText,
  defaultMediaStoreDeps,
  diskPathsOf,
  isOsFileDrop,
  explorerDropFiles,
  markdownLinkTarget,
  markdownSnippet,
  storeImagesForDocument,
  takeImageFiles,
  type MediaStoreDeps,
} from './editor-media-drop';
import { isUntitledPath } from '../../../electron/shared/untitled';

export interface CodeMirrorMediaDropOptions {
  /** 文档路径(取值时读,改名后仍是最新)。 */
  readonly documentPath: () => string;
  /** 是 Markdown(源码视图):⇧ 放下插入链接、可粘贴 / 拖入图片。 */
  readonly markdown: boolean;
  readonly deps?: MediaStoreDeps;
}

interface PendingRange {
  readonly id: number;
  readonly from: number;
  readonly to: number;
}

const addPending = StateEffect.define<PendingRange>();
const removePending = StateEffect.define<number>();

/** 存图期间的待插入范围:随编辑映射(插入点前的输入把它往后推;范围被删 → 收成一点)。 */
const pendingField = StateField.define<readonly PendingRange[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged
      ? value.map((r) => {
          const from = tr.changes.mapPos(r.from, -1);
          return { id: r.id, from, to: Math.max(from, tr.changes.mapPos(r.to, 1)) };
        })
      : value;
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(removePending)) next = next.filter((r) => r.id !== e.value);
    }
    return next;
  },
});

let nextPendingId = 1;

/** 在 [from, to] 处(存图完成时映射后的位置)插入 Markdown 图片 / 链接并选中占位。 */
async function insertImagesWhenStored(
  view: EditorView,
  from: number,
  to: number,
  files: readonly File[],
  opts: CodeMirrorMediaDropOptions,
  userEvent: 'input.paste' | 'input.drop',
): Promise<void> {
  const id = nextPendingId++;
  view.dispatch({ effects: addPending.of({ id, from, to }) });
  const documentPath = opts.documentPath();
  let stored: string[] = [];
  try {
    stored = await storeImagesForDocument(isUntitledPath(documentPath) ? null : documentPath, files, opts.deps ?? defaultMediaStoreDeps);
  } finally {
    // 存图期间视图可能已销毁(关 tab / 切模式):不再插入(图片文件留着,同 VSCode 先建文件后插入)
    try {
      const range = view.state.field(pendingField, false)?.find((r) => r.id === id);
      const effects = removePending.of(id);
      if (range && stored.length > 0) {
        const { text, placeholders } = markdownSnippet(stored.map((p) => markdownLinkTarget(documentPath, p, true)));
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: text },
          selection: EditorSelection.create(
            placeholders.map((p) => EditorSelection.range(range.from + p.from, range.from + p.to)),
          ),
          effects,
          userEvent,
          scrollIntoView: true,
        });
      } else if (range) {
        view.dispatch({ effects });
      }
    } catch {
      /* 视图已销毁 */
    }
  }
}

function insertTextAt(view: EditorView, pos: number, text: string, placeholders?: readonly { from: number; to: number }[]): void {
  view.focus();
  view.dispatch({
    changes: { from: pos, insert: text },
    selection:
      placeholders && placeholders.length > 0
        ? EditorSelection.create(placeholders.map((p) => EditorSelection.range(pos + p.from, pos + p.to)))
        : { anchor: pos + text.length },
    userEvent: 'input.drop',
    scrollIntoView: true,
  });
}

/** CodeMirror 的拖放 / 粘贴处理(见文件头)。 */
export function codeMirrorMediaDrop(opts: CodeMirrorMediaDropOptions): Extension {
  return [
    pendingField,
    EditorView.domEventHandlers({
      drop(event, view) {
        const dt = event.dataTransfer;
        if (hasExplorerDrag(dt)) {
          // 不插入 text/plain 的路径;不阻止冒泡 —— dockview 的放置区接着打开文件(⇧ 时它不接收,见 explorer-editor-drop)
          event.preventDefault();
          if (!event.shiftKey || view.state.readOnly) return true;
          const files = explorerDropFiles(readExplorerDragData(dt)?.entries ?? []);
          if (files.length === 0) return true;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
          const documentPath = opts.documentPath();
          if (opts.markdown && !isUntitledPath(documentPath)) {
            const { text, placeholders } = markdownSnippet(files.map((p) => markdownLinkTarget(documentPath, p)));
            insertTextAt(view, pos, text, placeholders);
          } else {
            insertTextAt(view, pos, codeDropText(files, (opts.deps ?? defaultMediaStoreDeps).workspaceRoot()));
          }
          return true;
        }
        if (!isOsFileDrop(dt)) return false; // 文字拖动等:CodeMirror 照常
        // 磁盘文件:一律拦下内建 drop(读文件内容插入);不阻止冒泡 —— 没插入的由编辑器面板打开
        event.preventDefault();
        if (view.state.readOnly) return true;
        const { files, hadDirectory } = captureDroppedRegularFiles(dt!, MAX_DROP_FILES);
        if (hadDirectory) return true; // 拖入文件夹:窗口级打开为工作区
        const images = opts.markdown ? takeImageFiles(files) : [];
        const others = images.length === 0 ? files : files.filter((f) => !images.includes(f));
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        let at = pos;
        if (event.shiftKey && others.length > 0) {
          const paths = diskPathsOf(others, (opts.deps ?? defaultMediaStoreDeps).getPathForFile);
          claimDroppedFiles(event, others);
          if (paths.length > 0) {
            const documentPath = opts.documentPath();
            if (opts.markdown && !isUntitledPath(documentPath)) {
              const { text, placeholders } = markdownSnippet(paths.map((p) => markdownLinkTarget(documentPath, p)));
              insertTextAt(view, pos, images.length > 0 ? `${text} ` : text, placeholders);
              at = pos + text.length + (images.length > 0 ? 1 : 0);
            } else {
              insertTextAt(view, pos, codeDropText(paths, (opts.deps ?? defaultMediaStoreDeps).workspaceRoot()));
            }
          }
        }
        if (images.length > 0) {
          claimDroppedFiles(event, images);
          view.focus();
          void insertImagesWhenStored(view, at, at, images, opts, 'input.drop');
        }
        return true;
      },
      paste(event, view) {
        if (!opts.markdown || view.state.readOnly) return false;
        const data = event.clipboardData;
        if (!data || data.getData('text/plain') !== '') return false;
        const images = takeImageFiles(data.files);
        if (images.length === 0) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        void insertImagesWhenStored(view, from, to, images, opts, 'input.paste');
        return true;
      },
    }),
  ];
}
