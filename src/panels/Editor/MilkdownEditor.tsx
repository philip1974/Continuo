// M-Editor Step E3:Milkdown/Crepe 包装。
// 从维护者早期原型的 MilkdownEditor 移植,Crepe features 配置一致:
//   开:CodeMirror / ListItem / LinkTooltip / Cursor / BlockEdit / Toolbar / Placeholder / Table
//   关:ImageBlock / Latex(不接图片上传 UI 与数学公式;键入图片语法转图片由 insertImageInputRule 负责;
//   粘贴 / 拖入图片由 milkdown-media-drop 覆盖 Crepe 的上传器,存成文件再插相对路径)
// ```mermaid 代码块经 CodeMirror 特性的 renderPreview 渲染成图(见 mermaid-preview.ts)。
//
// 注意:Crepe 主题 CSS 自成体系,不与 Tailwind 冲突;直接 import frame-dark。

import { visibleUntrustedText } from '@/lib/untrusted-text';
import { MAX_EXTERNAL_URL_LEN } from '../../../electron/shared/url-limits';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { insertImageInputRule } from '@milkdown/kit/preset/commonmark';
import { $prose } from '@milkdown/kit/utils';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { markdownImageUploadConfig, markdownMediaDropPlugin } from './milkdown-media-drop';
import { dropIndicatorDestroyGuard } from './milkdown-drop-indicator-guard';
import { codeMirrorMediaDrop } from './codemirror-media-drop';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import { clampFloatingToViewport } from './milkdown-floating-clamp';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
// 必须在 Crepe theme 之后,才能 override 它的 px 字号(详见文件注释)
import '@/styles/milkdown-font-override.css';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EDITOR_FONT_SIZE,
} from '@/plugins/settings/core-setting-specs';
import { t, useLocale, type TranslationKey } from '@/i18n';
import { useTheme } from '@/theme';
import {
  redrawMermaidPreviews,
  registerMermaidRoot,
  renderMermaidPreview,
} from './mermaid-preview';
import { registerEditorWriteBack } from './editor-writeback-registry';
import { registerEditorRootRebind } from './editor-root-registry';
import { registerEditorFocus } from './editor-focus-registry';
import { registerMarkdownReveal, type MarkdownRevealTarget } from './markdown-reveal-registry';
import { createPmOutlineHandle, registerMarkdownOutline, type PmOutlineView } from './markdown-outline-registry';
import { installGithubHeadingIds } from './markdown-heading-id';
import { useEditorGroupId } from './editor-group-context';
import { useEditorGroupNumber } from './editor-group-number';
import { setContentFocusHandler } from '@/lib/content-focus-target';
import {
  markdownScrollTopOf,
  saveMarkdownModeAnchor,
  saveMarkdownScrollTop,
  takeMarkdownModeAnchor,
} from './editor-view-state-cache';
import {
  parseMarkdownTree,
  posForSourceLine,
  rangeForSourceMatch,
  sourceLineAtPos,
  topVisibleSourceLine,
  viewportYOfSourceLine,
  type MdNode,
  type PmNode,
  type PmViewLike,
  type RemarkLike,
} from './markdown-position-map';
import { useEditorStore } from '@/stores/editor.store';
import { rebindCodeMirrorRoots } from './codemirror-root';
import { markdownCodeBlockTheme } from './code-editor-theme';
import { codeMirrorContentLabel, codeMirrorPhrases, editorContentLabel, previewContentLabel } from './codemirror-phrases';
import { copyToClipboardOrNotify } from '@/panels/Explorer/copy-to-clipboard';
import { MARKDOWN_EDITOR_ATTR } from '@/lib/editor-text-focus';
import { markdownImageNodeView } from './markdown-image-view';
import { configureMarkdownStyle } from './milkdown-markdown-style';
import { configureSourceBlocks } from './milkdown-source-blocks';
import { configureMarkdownMath } from './milkdown-math';
import { markdownWritingKeys } from './milkdown-writing-keys';
import { imagePasteSchema, pasteHistoryBoundary } from './milkdown-paste';
import {
  escapeRegExp,
  forgetMarkdownFindSession,
  markdownFindPlugin,
  markdownFindSessionOf,
  onMarkdownFindChange,
  saveMarkdownFindSession,
  revealMarkdownFindMatch,
  selectAndRevealMarkdownRange,
  setMarkdownFindQuery,
  stepMarkdownFind,
  type MarkdownFindResult,
} from './markdown-find';
import { TerminalSearchBar } from '@/panels/Terminal/TerminalSearchBar';
import { editorFindHistory, FIND_MATCH_LIMIT, formatFindCount } from './find-widget-model';
import { registerMarkdownFind } from './markdown-find-registry';
import { clampSearchQuery } from '@/lib/search-query';
import type { SearchApi } from '@/panels/Terminal/useTerminal';
import {
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  type TerminalSearchOptions,
} from '@/panels/Terminal/terminal-search-state';

interface MilkdownEditorProps {
  /**
   * 所属 tab id,用于按 tab 登记同步回写(只回写受影响的 tab)。挂载时取定:EditorPanel 的 key
   * 含 tab id,id 变化(改名)即重挂载。
   */
  tabId: string;
  /** 文件路径:编辑区可访问名称「<文件名>，编辑器」用(挂载时取定;改名 = tab id 变 → 重挂)。 */
  fileName?: string;
  defaultValue: string;
  /**
   * 当前内容(store 里的文档内容;预览为其预览形态)。变化且不是本视图最近上抛 / 回写的内容(= 被别处改了,如另一编辑器组)
   * → 以最小差异的事务套进视图:不重挂载,光标 / 选区随变化映射,本视图撤销栈保留(该事务不进撤销栈)。缺省不同步。
   */
  value?: string;
  /**
   * 磁盘重载代际(tab.reloadEpoch:还原文件 / 外部修改自动重载递增)。变化时随之到来的 value 以**可撤销**的一步套进视图
   *(VSCode ModelService.updateModel:pushStackElement + 最小差异编辑),⌘Z 可找回重载前的内容;不重挂载,焦点 / 光标保留。
   * BDD: src/__tests__/editor-revert-file/
   */
  reloadEpoch?: number;
  readonly?: boolean;
  onChange?: (markdown: string) => void;
  /**
   * Cmd/Ctrl+click on `<a>` 时触发,把 anchor 的 href 上抛给上层路由。
   * 上层(EditorPanel)用 resolveLink 决定打开内部文件还是外链。见 issue #25。
   */
  onLinkClick?: (href: string) => void;
  /**
   * 同步回写:上抛有 200ms 起的防抖(大文档按序列化耗时拉长)且销毁不 flush。关窗 flush 握手(flushEditorWriteBacks)
   * 与卸载(切 tab / 切 mode / 重挂载)时,若编辑器里有尚未上抛的编辑,同步取全文回调。
   * `base` = 最近一次上抛(或挂载时)的内容,供上层判断 store 是否已被别处改过。缺省走 onChange。
   */
  onWriteBack?: (markdown: string, base: string) => void;
  /** 编辑器视图就绪(Crepe 异步创建完成)时回调(EditorPanel 据此收起较大文件的「正在渲染」提示)。 */
  onViewReady?: () => void;
}

/** 斜杠菜单(BlockEdit)分组与条目名;icon 不传,沿用 Crepe 默认。 */
function crepeSlashMenuLabels() {
  const item = (key: TranslationKey) => ({ label: t(key) });
  return {
    textGroup: {
      label: t('panels.editor.md.slash.textGroup'),
      text: item('panels.editor.md.slash.text'),
      h1: item('panels.editor.md.slash.h1'),
      h2: item('panels.editor.md.slash.h2'),
      h3: item('panels.editor.md.slash.h3'),
      h4: item('panels.editor.md.slash.h4'),
      h5: item('panels.editor.md.slash.h5'),
      h6: item('panels.editor.md.slash.h6'),
      quote: item('panels.editor.md.slash.quote'),
      divider: item('panels.editor.md.slash.divider'),
    },
    listGroup: {
      label: t('panels.editor.md.slash.listGroup'),
      bulletList: item('panels.editor.md.slash.bulletList'),
      orderedList: item('panels.editor.md.slash.orderedList'),
      taskList: item('panels.editor.md.slash.taskList'),
    },
    advancedGroup: {
      label: t('panels.editor.md.slash.advancedGroup'),
      codeBlock: item('panels.editor.md.slash.codeBlock'),
      table: item('panels.editor.md.slash.table'),
      math: item('panels.editor.md.slash.math'),
    },
  };
}

// ProseMirror 文档(Node)只用作引用比较与序列化入参,不依赖其结构。
type PmDoc = object;

/**
 * 取编辑器当前文档与 markdown 序列化器。@milkdown/kit 不是直接依赖,不 import
 * editorViewCtx / serializerCtx,按 slice 名取(名字由 milkdown-ctx-contract.spec 用真实 Crepe 钉住)。
 */
function readEditor(crepe: Crepe): { doc: PmDoc; serialize: (doc: PmDoc) => string } {
  const ctx = crepe.editor.ctx;
  return {
    doc: ctx.get<{ state: { doc: PmDoc } }, 'editorView'>('editorView').state.doc,
    serialize: ctx.get<(doc: PmDoc) => string, 'serializer'>('serializer'),
  };
}

// @milkdown/plugin-listener 的防抖窗口(updated 已在其后触发)。
const LISTENER_DEBOUNCE_MS = 200;
const MAX_EMIT_DELAY_MS = 2000;
const EMIT_DELAY_PER_SERIALIZE_MS = 8;
// 用户一直在打字时额外延迟会被反复重排;从本轮首次未上抛的变化起最多等这么久必上抛。
const MAX_EMIT_WAIT_MS = 5000;

/** 防抖上抛的总延迟:max(200ms, 序列化耗时 × 8),封顶 2s。序列化 <25ms 时即 200ms。 */
function emitDelayMs(serializeMs: number): number {
  return Math.min(
    MAX_EMIT_DELAY_MS,
    Math.max(LISTENER_DEBOUNCE_MS, serializeMs * EMIT_DELAY_PER_SERIALIZE_MS),
  );
}

/** ProseMirror 视图里重绑 root 用到的部分(按 slice 名取,同 readEditor)。 */
interface PmRootView {
  readonly dom: HTMLElement;
  readonly root: Document | ShadowRoot;
  updateRoot(): void;
  /**
   * 内部 API(prosemirror-view 1.42.x 的 DOMObserver):selectionchange 监听按调用时 `dom.ownerDocument`
   * 挂 / 移,`updateRoot()` 只清 root 缓存、不迁移监听;公开 API 无迁移手段。`connectSelection` 不先移除旧监听。
   */
  readonly domObserver?: {
    readonly onSelectionChange: EventListener;
    connectSelection(): void;
  };
}

function readPmRootView(crepe: Crepe): PmRootView | null {
  let view: PmRootView;
  try {
    view = crepe.editor.ctx.get<PmRootView, 'editorView'>('editorView');
  } catch {
    return null;
  }
  return typeof view.updateRoot === 'function' ? view : null; // slice 初值是空对象
}

// 各 ProseMirror 视图的 selectionchange 监听当前挂在哪个文档:挂载时记,每次重绑后更新。
// DOM 已移走后无从得知旧文档,只能事先记下。
const selectionDocs = new WeakMap<PmRootView, Document>();

/** 视图挂载后记下 selectionchange 监听所在文档(构造时按 `dom.ownerDocument` 挂)。 */
function recordSelectionDoc(crepe: Crepe): void {
  const view = readPmRootView(crepe);
  if (view) selectionDocs.set(view, view.dom.ownerDocument);
}

/**
 * popout 弹出 / 收回只移 DOM(见 editor-root-registry.ts):ProseMirror 视图 root 不是当前所在文档则 updateRoot,
 * selectionchange 监听从旧文档移到当前文档(否则旧文档一直持有视图,且首次事务前鼠标改选区不进 state);
 * 正文里的 CodeMirror 代码块(创建时取 ProseMirror 的 root)同样重绑。视图未就绪 / 已拆除时跳过。
 */
function rebindMilkdownRoot(crepe: Crepe): void {
  const view = readPmRootView(crepe);
  if (!view) return;
  const doc = view.dom.ownerDocument;
  const prevDoc = selectionDocs.get(view);
  const observer = view.domObserver;
  if (prevDoc && prevDoc !== doc && observer) {
    prevDoc.removeEventListener('selectionchange', observer.onSelectionChange);
    observer.connectSelection();
  }
  selectionDocs.set(view, doc);
  if (view.root !== doc) view.updateRoot();
  rebindCodeMirrorRoots(view.dom);
}

interface WriteBackHandle {
  writeBack: () => void;
  dispose: () => void;
  /**
   * 套用别处改过的内容(见 props.value);视图未就绪时 no-op(挂载时再按最新 value 补)。undoable = 磁盘重载(见
   * props.reloadEpoch):这一步单独成一个撤销组;否则不进撤销栈。
   */
  applyExternal: (markdown: string, undoable?: boolean) => void;
}

/** 增量套用外部内容用到的 ProseMirror 部分(按 slice 名取,同 readEditor)。 */
interface PmFragmentLike {
  findDiffStart(other: PmFragmentLike): number | null;
  findDiffEnd(other: PmFragmentLike): { a: number; b: number } | null;
}
interface PmSyncDoc {
  readonly content: PmFragmentLike;
  slice(from: number, to: number): unknown;
}
type PmSyncTr = Parameters<typeof closeHistory>[0];
interface PmSyncView {
  readonly state: {
    readonly doc: PmSyncDoc;
    readonly tr: PmSyncTr;
  };
  dispatch(tr: unknown): void;
}

/**
 * 把视图文档换成 `next`,只替换两者不同的那一段(公共前后缀之外;ProseMirror 官方示例的 findDiffStart / findDiffEnd 做法):
 * 选区随事务映射。缺省不进撤销栈(prosemirror-history 把本视图已有的撤销历史映射过这一步);undoable(磁盘重载)→ 进撤销栈且
 * 前后各断开一次(closeHistory),自成一组:不与之前的输入合并,之后的输入也不并进来(VSCode updateModel 前后 pushStackElement)。
 */
function replaceDocMinimal(view: PmSyncView, next: PmSyncDoc, undoable = false): void {
  const cur = view.state.doc;
  const start = cur.content.findDiffStart(next.content);
  if (start === null) return;
  let { a: endA, b: endB } = cur.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const tr = view.state.tr.replace(start, endA, next.slice(start, endB) as Parameters<PmSyncTr['replace']>[2]);
  if (!undoable) {
    view.dispatch(tr.setMeta('addToHistory', false));
    return;
  }
  view.dispatch(closeHistory(tr));
  view.dispatch(closeHistory(view.state.tr));
}

/**
 * 切换 源码 / 编辑 / 预览 时的定位句柄(按源码行;BDD: src/__tests__/markdown-mode-position/)。
 * `scroller` = 滚动容器(外层 wrapper)。
 */
interface MarkdownPositionHandle {
  /** 顶部可见的源码行与光标所在行(只读预览无光标)。 */
  anchor(scroller: HTMLElement): { topLine: number; cursorLine?: number } | null;
  /** 把源码行滚到滚动容器顶边。 */
  scrollToLine(scroller: HTMLElement, line: number): void;
  /** 光标移到源码行对应的块(只读预览忽略)。 */
  setCursorLine(line: number): void;
  /**
   * 定位到源码行 / 列并选中匹配(在文件中查找打开结果,见 markdown-reveal-registry):选中、聚焦、在视口外则滚到中央。
   * 行号超出 → out-of-range;视图已拆除 → null。
   */
  reveal(scroller: HTMLElement, target: MarkdownRevealTarget): 'applied' | 'out-of-range' | null;
}

/** 编辑器视图就绪(Crepe 异步创建完成)时回调,带聚焦与定位句柄,以及取 ProseMirror 视图(查找用;已拆除 → null)。 */
type OnEditorReady = (focus: () => void, position: MarkdownPositionHandle, getView: () => EditorView | null) => void;

/** 切换界面语言重挂前记下的编辑状态(选区按 ProseMirror 位置;同一份内容重建的文档结构相同)。 */
interface RelocaleSnapshot {
  readonly anchor: number;
  readonly head: number;
  /** 焦点在编辑区内(含代码块里的 CodeMirror)。 */
  readonly focused: boolean;
}

/** 重挂后还原选区与焦点(位置夹进新文档;TextSelection.between 落到最近的合法文本位置)。 */
function restoreRelocaleSnapshot(view: EditorView, snapshot: RelocaleSnapshot): void {
  const size = view.state.doc.content.size;
  const clamp = (pos: number): number => Math.max(0, Math.min(pos, size));
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(clamp(snapshot.anchor)), doc.resolve(clamp(snapshot.head)))));
  if (snapshot.focused) focusEditorView(view);
}

/** 聚焦编辑区:只读预览的 ProseMirror 不可编辑,view.focus() 不聚焦它 → 直接聚焦其 DOM(预览区 tabIndex=0)。 */
function focusEditorView(view: EditorView): void {
  if (view.editable === false) view.dom.focus({ preventScroll: true });
  else view.focus();
}

/** 定位用到的 ProseMirror 视图部分(按 slice 名取,同 readEditor)。 */
interface PmPositionView extends PmViewLike {
  readonly state: {
    readonly doc: PmNode & { resolve(pos: number): unknown };
    readonly selection: { readonly head: number; readonly constructor: { near(pos: unknown): unknown } };
    readonly tr: { setSelection(selection: unknown): unknown };
  };
  dispatch(tr: unknown): void;
}

function CrepeEditor({
  tabId,
  fileName,
  defaultValue,
  value,
  reloadEpoch,
  readonly = false,
  onChange,
  onWriteBack,
  onReady,
  onUnmount,
}: MilkdownEditorProps & { readonly onReady?: OnEditorReady; readonly onUnmount?: () => void }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWriteBackRef = useRef(onWriteBack);
  onWriteBackRef.current = onWriteBack;
  const writeBackRef = useRef<WriteBackHandle | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  // 多个编辑器组时编辑区名称带组号(随拖动换位 / 增删组变化,见 editor-group-number);挂载时取最新值,之后就地更新
  const groupNumber = useEditorGroupNumber(useEditorGroupId());
  const groupNumberRef = useRef(groupNumber);
  groupNumberRef.current = groupNumber;

  // 注:useEditor 的 callback 在 mount 时执行,defaultValue 只在挂载时生效。
  // 切 tab 时通过 EditorPanel 上的 key={activeTabId} 强制 remount,
  // 让 Crepe 拿到新 tab 的初始 markdown(Mind 同模式)。
  const editorCallback = useCallback((root: HTMLElement) => {
    const crepe = new Crepe({
      root,
      defaultValue,
      features: {
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.Cursor]: true,
        // 不接图片插入 / 上传 UI;图片显示走下方 image nodeView(markdown-image-view)
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.Table]: true,
        // 数学公式(KaTeX 懒加载;识别规则 / 原样往返 / 渲染见 milkdown-math、katex-render)。BDD: src/__tests__/markdown-math/
        [CrepeFeature.Latex]: true,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: t('panels.editor.placeholder.start_writing'),
        },
        // Crepe 浮层文案默认英文,逐项接 catalog(语言切换靠 Provider 的 locale key 重挂)。
        // 只配启用特性里会显示的项:图片特性已关,其菜单项不出现。
        // 斜杠菜单只有 flip + offset,窄窗口时越出右边被裁 → 追加水平夹回视口的中间件(见 milkdown-floating-clamp)。
        [CrepeFeature.BlockEdit]: {
          ...crepeSlashMenuLabels(),
          slashMenu: { middleware: [clampFloatingToViewport()] },
        },
        [CrepeFeature.Toolbar]: {
          boldLabel: t('panels.editor.md.toolbar.bold'),
          italicLabel: t('panels.editor.md.toolbar.italic'),
          strikethroughLabel: t('panels.editor.md.toolbar.strikethrough'),
          codeLabel: t('panels.editor.md.toolbar.code'),
          linkLabel: t('panels.editor.md.toolbar.link'),
          latexLabel: t('panels.editor.md.toolbar.math'),
        },
        [CrepeFeature.LinkTooltip]: {
          inputPlaceholder: t('panels.editor.md.link.placeholder'),
        },
        [CrepeFeature.CodeMirror]: {
          // 不传则 Crepe 默认 oneDark(亮色主题下仍深色);token 主题亮 / 暗通用,切主题不重挂。
          theme: markdownCodeBlockTheme,
          // 代码块的 CodeMirror 同样带 basicSetup 的 ⌘F 查找面板:内建文案随界面语言(Provider 按 locale 重挂,创建时取当前语言)。
          // 代码块文本区同为 role=textbox,须有可访问名称(axe aria-input-field-name)。
          // 资源管理器拖到代码块:只打开,⇧ 放下插入路径(同代码文件;BDD: src/__tests__/explorer-drag-out/)
          extensions: [
            codeMirrorPhrases(),
            codeMirrorContentLabel(t('editor.aria.code_block')),
            codeMirrorMediaDrop({ documentPath: () => fileName ?? '', markdown: false }),
          ],
          renderPreview: renderMermaidPreview,
          copyText: t('panels.editor.codeBlock.copy'),
          searchPlaceholder: t('panels.editor.codeBlock.searchLanguage'),
          noResultText: t('panels.editor.codeBlock.noResult'),
          previewLabel: t('panels.editor.codeBlock.previewLabel'),
          previewLoading: t('panels.editor.codeBlock.previewLoading'),
          previewToggleText: (previewOnlyMode) =>
            previewOnlyMode
              ? t('panels.editor.codeBlock.previewEdit')
              : t('panels.editor.codeBlock.previewHide'),
        },
      },
    });
    // 序列化风格跟随原文件(列表符号 / 分隔线 / 标题 / 代码块 / 表格对齐),不写 `<br />` 空行占位,少转义;未改动的块原样写回、
    // 行尾跟随原文件(CRLF);选中文字粘贴 URL 成链接、⌘K 链接框、表格 Tab。BDD: src/__tests__/editor-milkdown-roundtrip-style/、
    // src/__tests__/editor-milkdown-roundtrip-verbatim/、src/__tests__/editor-markdown-writing-keys/
    configureMarkdownStyle(crepe, defaultValue);
    const sourceBlocks = configureSourceBlocks(crepe, defaultValue);
    configureMarkdownMath(crepe);
    crepe.editor.use(markdownWritingKeys);
    // 粘贴前后断开撤销;粘贴网页 HTML 时图片 title 不取 alt(代码块语言见 milkdown-math 的代码块 schema)。BDD: src/__tests__/editor-clipboard/
    crepe.editor.use(pasteHistoryBoundary);
    crepe.editor.use(imagePasteSchema);

    // Markdown 图片:image 节点换成自定义视图 —— 相对路径按文档目录解析、经受控通道(仅工作区内)加载,失败给 alt 占位;
    // 只换 DOM 视图,src 原样留在文档里(序列化不变)。按 slice 名 'nodeView' 注册(@milkdown/kit 非直接依赖,
    // 真实 Crepe 下的效果由 editor-image-preview/markdown-image.spec 钉住)。BDD: src/__tests__/editor-image-preview/
    crepe.editor.config((ctx) =>
      ctx.update<ReadonlyArray<readonly [string, unknown]>, 'nodeView'>('nodeView', (views) => [
        ...views,
        ['image', markdownImageNodeView(fileName ?? null)],
      ]),
    );
    // 键入 `![alt](path "title")` 即转成图片节点(Milkdown commonmark 自带此输入规则,但 preset 默认未启用;Crepe 只在
    // ImageBlock 特性里给块级图片接规则,本项目关着它)。不接则整串被当文本保存成转义的 `!\[alt]\(path)`。
    // 生成的仍是行内 image 节点 → 走上面的 nodeView 显示,序列化回原样 `![alt](path)`。BDD: src/__tests__/editor-image-preview/
    crepe.editor.use(insertImageInputRule);
    // ⌘F 查找的高亮 / 当前匹配(装饰,不改文档)。BDD: src/__tests__/markdown-find/
    crepe.editor.use($prose(() => markdownFindPlugin));
    // 粘贴截图 / 拖入图片:存成文档旁的图片文件再插入相对路径(不写 blob: / data:);资源管理器拖来的文件只打开,⇧ 放下插入链接。
    // BDD: src/__tests__/markdown-image-paste/、src/__tests__/explorer-drag-out/
    const documentPath = (): string | null => fileName ?? null;
    crepe.editor.config((ctx) => ctx.update(uploadConfig.key, markdownImageUploadConfig(documentPath)));
    crepe.editor.use($prose(() => markdownMediaDropPlugin(documentPath)));
    // 放下即销毁编辑器(打开别的文件 / 关 tab)时拖放指示线的延迟隐藏不抛错(见 milkdown-drop-indicator-guard)
    crepe.editor.use(dropIndicatorDestroyGuard);
    // 标题 id = GitHub slug(重复加 -1 / -2),与 `#片段` 链接解析同一规则。BDD: src/__tests__/markdown-anchor-links/
    installGithubHeadingIds(crepe.editor);
    if (readonly) crepe.setReadonly(true);
    crepeRef.current = crepe;

    // 回写状态(每个 Crepe 实例独立):baseDoc = 编辑器最近一次已处理的文档(挂载时 / 每次上抛 /
    // 回写),据此判断有无尚未上抛的编辑 —— ProseMirror 文档不可变,引用相等即未变,不必序列化
    // (大文档全量序列化一次约 70ms)。baseMarkdown = baseDoc 的序列化,惰性算:挂载时不序列化。
    // lastEmitted = 最近上抛给 store 的内容(初值 = 挂载内容)。disposed 后迟到的防抖 emit 不再
    // 上抛 —— 卸载时已同步回写,迟到 emit 可能覆盖之后的新编辑(切到 Source 继续输入)或外部重载。
    let baseDoc: PmDoc | null = null;
    let baseMarkdown: string | null = null;
    let lastEmitted = defaultValue;
    let disposed = false;
    let serializeMs = 0; // 最近一次全量序列化实测耗时,决定防抖上抛的延迟
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    // 排期上抛时(updated / 重排)的文档与本轮首次排期时刻:到点时文档又变了 = 用户仍在打字。
    let pendingDoc: PmDoc | null = null;
    let pendingSince = 0;

    // 编辑器当前文档相对 baseDoc 有无尚未上抛的编辑:有 → 推进基线并返回新全文,否则 null。
    // 只差尾部空白不算编辑:挂载期 Milkdown 会给以代码块 / 表格结尾的文档补一个尾随空段落,不是
    // 用户编辑,不上抛(否则打开即变脏、自动保存改写文件,issue #44)。不能用「吞掉第一次 emit」
    // 判断:以段落结尾的文档挂载期没有这次 emit,会吞掉用户的第一次真实编辑。
    const takeEdit = (): string | null => {
      const { doc, serialize } = readEditor(crepe);
      if (doc === baseDoc) return null;
      // 基线必须用挂载时(或上次处理时)的文档序列化:单纯查看不被规范化改写。
      const prev = baseDoc === null ? null : (baseMarkdown ??= serialize(baseDoc));
      const t0 = performance.now();
      const markdown = serialize(doc);
      serializeMs = performance.now() - t0;
      baseDoc = doc;
      baseMarkdown = markdown;
      return prev !== null && markdown.trimEnd() === prev.trimEnd() ? null : markdown;
    };

    // 按额外延迟排期上抛,截到本轮总等待上限(到上限即刻到点)。
    const scheduleEmit = (doc: PmDoc): void => {
      if (pendingDoc === null) pendingSince = performance.now();
      pendingDoc = doc;
      const left = Math.max(0, MAX_EMIT_WAIT_MS - (performance.now() - pendingSince));
      const extra = emitDelayMs(serializeMs) - LISTENER_DEBOUNCE_MS;
      emitTimer = setTimeout(emitPending, Math.min(extra, left));
    };

    const emitPending = () => {
      emitTimer = null;
      if (disposed) return;
      // 到点时文档相对排期时又变了(用户仍在打字,listener 防抖还没到):此刻全量序列化(大文档约 70ms)
      // 会卡在打字中途 → 按额外延迟重排。不能直接放弃:addToHistory=false 的事务不再触发 updated。
      if (pendingDoc !== null) {
        let doc: PmDoc;
        try {
          doc = readEditor(crepe).doc;
        } catch {
          return;
        }
        const waited = performance.now() - pendingSince;
        if (doc !== pendingDoc && waited < MAX_EMIT_WAIT_MS) {
          scheduleEmit(doc);
          return;
        }
        pendingDoc = null;
      }
      let markdown: string | null;
      try {
        markdown = takeEdit();
      } catch {
        return;
      }
      if (markdown === null) return;
      lastEmitted = markdown;
      onChangeRef.current?.(markdown);
    };

    // 定位:用 Milkdown 自己的 remark 处理器把当前内容解析成带行号的 mdast,与文档同步下钻(见 markdown-position-map)。
    // 当前内容 = 最近一次上抛 / 挂载时的内容(文档未变时),否则序列化当前文档 —— 与随后回写进 store 的一致。
    const positionContext = (): { view: PmPositionView; tree: MdNode; markdown: string } => {
      const ctx = crepe.editor.ctx;
      const view = ctx.get<PmPositionView, 'editorView'>('editorView');
      const doc = view.state.doc;
      const markdown =
        baseDoc === null || doc === baseDoc ? lastEmitted : ctx.get<(d: PmDoc) => string, 'serializer'>('serializer')(doc);
      return { view, tree: parseMarkdownTree(ctx.get<RemarkLike, 'remark'>('remark'), markdown), markdown };
    };
    const position: MarkdownPositionHandle = {
      anchor: (scroller) => {
        try {
          const { view, tree } = positionContext();
          const doc = view.state.doc;
          const topLine = topVisibleSourceLine(doc, tree, view, scroller.getBoundingClientRect().top);
          if (topLine === null) return null;
          return readonly ? { topLine } : { topLine, cursorLine: sourceLineAtPos(doc, tree, view.state.selection.head) };
        } catch {
          return null; // 未就绪 / 已拆除
        }
      },
      scrollToLine: (scroller, line) => {
        try {
          const { view, tree } = positionContext();
          const y = viewportYOfSourceLine(view.state.doc, tree, view, line);
          if (y !== null) scroller.scrollTop += y - scroller.getBoundingClientRect().top;
        } catch {
          /* 未就绪 / 已拆除 */
        }
      },
      setCursorLine: (line) => {
        if (readonly) return;
        try {
          const { view, tree } = positionContext();
          const pos = posForSourceLine(view.state.doc, tree, line);
          if (pos === null) return;
          // @milkdown/kit 非直接依赖:经当前选区的类取 Selection.near(静态方法随子类继承)。只改选区,不改文档。
          const near = view.state.selection.constructor.near(view.state.doc.resolve(pos));
          view.dispatch(view.state.tr.setSelection(near));
        } catch {
          /* 未就绪 / 已拆除 */
        }
      },
      reveal: (scroller, { line, column, length }) => {
        if (disposed) return null;
        let view: EditorView;
        let range: { from: number; to: number } | null;
        try {
          const context = positionContext();
          view = crepe.editor.ctx.get<EditorView, 'editorView'>('editorView');
          range = rangeForSourceMatch(context.view.state.doc, context.tree, context.markdown, line, column, length);
        } catch {
          return null; // 未就绪 / 已拆除
        }
        if (!range) return 'out-of-range';
        selectAndRevealMarkdownRange(view, scroller, range.from, range.to);
        focusEditorView(view);
        return 'applied';
      },
    };

    writeBackRef.current = {
      writeBack: () => {
        if (readonly || disposed || baseDoc === null) return;
        let markdown: string | null;
        try {
          markdown = takeEdit();
        } catch {
          return; // 编辑器未就绪 / 已拆除:无可回写内容
        }
        if (markdown === null) return;
        const base = lastEmitted;
        lastEmitted = markdown;
        if (onWriteBackRef.current) onWriteBackRef.current(markdown, base);
        else onChangeRef.current?.(markdown);
      },
      dispose: () => {
        disposed = true;
        if (emitTimer !== null) clearTimeout(emitTimer);
        emitTimer = null;
      },
      // 别处(另一编辑器组 / 程序化)改了内容:增量套进视图,基线换成该内容 —— 之后到点的上抛 / 回写按它判定,
      // 不把套用结果再上抛。本视图尚未上抛的输入被覆盖(同此前重挂载;两组在防抖窗口内同时输入时后上抛者覆盖)。
      applyExternal: (markdown, undoable = false) => {
        if (disposed || markdown === lastEmitted) return;
        try {
          const ctx = crepe.editor.ctx;
          const view = ctx.get<PmSyncView, 'editorView'>('editorView');
          if (!view.state) return; // 未就绪(slice 初值是空对象):挂载时按最新 value 补
          replaceDocMinimal(view, sourceBlocks.parse(markdown) as PmSyncDoc, undoable);
          // 原文块与行尾按新内容重建(状态栏改行尾后,编辑模式的保存也按新行尾);只读预览不序列化,不必重建
          if (!readonly) sourceBlocks.resync(markdown);
          if (emitTimer !== null) clearTimeout(emitTimer);
          emitTimer = null;
          pendingDoc = null;
          lastEmitted = markdown;
          if (!readonly) {
            baseDoc = view.state.doc;
            baseMarkdown = markdown;
          }
        } catch {
          /* 已拆除 / 解析失败:保持原视图 */
        }
      },
    };

    crepe.on((listener) => {
      listener.mounted(() => recordSelectionDoc(crepe));
      // 创建(异步)期间内容又被别处改了:按最新 value 补套
      listener.mounted(() => {
        if (valueRef.current !== undefined) writeBackRef.current?.applyExternal(valueRef.current);
      });
      // 编辑 / 预览区(ProseMirror 根,role=textbox)的可访问名称(对齐 VSCode;BDD: src/__tests__/editor-accessible-name/)。
      // 只读预览:「<文件名>，预览」+ aria-readonly(VSCode Markdown 预览「Preview <文件名>」),不念成可编辑的编辑器。
      // 语言切换随 Provider 的 locale key 重挂、改名随 tab id 重挂,挂载时取当前值即可。setProps 与已有 props 合并。
      listener.mounted(() => {
        try {
          crepe.editor.ctx
            .get<{ setProps(props: { attributes: Record<string, string> }): void }, 'editorView'>('editorView')
            .setProps({
              // 只读预览可聚焦(tabIndex=0):⌘F 查找、键盘滚动与 F6 落点都要焦点在预览区里(VSCode 预览 webview 同可聚焦)。
              attributes: readonly
                ? { 'aria-label': previewContentLabel(fileName), 'aria-readonly': 'true', tabindex: '0' }
                : { 'aria-label': editorContentLabel(fileName, groupNumberRef.current) },
            });
        } catch {
          /* 已拆除 */
        }
      });
      const getView = (): EditorView | null => {
        try {
          return crepe.editor.ctx.get<EditorView, 'editorView'>('editorView');
        } catch {
          return null; // 已拆除
        }
      };
      listener.mounted(() => {
        const focus = (): void => {
          const view = getView();
          if (view) focusEditorView(view);
        };
        // 点 tab / dock tab、重启恢复等入口聚焦可编辑区时走 view.focus()(不直接 DOM focus,免得被拉回光标处;
        // 见 content-focus-target)
        const view = getView();
        if (view?.dom) setContentFocusHandler(view.dom, focus);
        onReady?.(focus, position, getView);
      });
      // 只读预览不回写也不上抛,不记基线、不挂其余 listener(省掉挂载时与防抖里的序列化)。
      if (readonly) return;
      listener.mounted(() => {
        try {
          baseDoc = readEditor(crepe).doc;
        } catch {
          /* 保持 null:不回写 */
        }
      });
      // 不用 markdownUpdated:它在 200ms 防抖里每次全量序列化。updated 触发条件相同(防抖到点且文档
      // 相对上次有变)但不序列化;由这里按实测序列化耗时自适应延迟后再序列化上抛 —— 小文档
      // (<25ms)防抖到点即上抛,与原 200ms 节奏一致。延迟期间的保存 / 关窗 / 卸载由 writeBack 同步补齐,
      // 之后到点按当前文档判定,不重复、不回退上抛旧内容;到点时用户仍在打字则重排(见 emitPending)。
      listener.updated(() => {
        if (disposed) return;
        if (emitTimer !== null) clearTimeout(emitTimer);
        emitTimer = null;
        if (emitDelayMs(serializeMs) <= LISTENER_DEBOUNCE_MS) {
          pendingDoc = null;
          emitPending();
          return;
        }
        let doc: PmDoc;
        try {
          doc = readEditor(crepe).doc;
        } catch {
          return;
        }
        scheduleEmit(doc);
      });
    });

    return crepe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEditor(editorCallback);

  // 卸载前(layout 清理:先于子组件 <Milkdown/> 销毁编辑器,DOM 仍在)通知外层记下编辑状态(语言切换重挂用)
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  useLayoutEffect(() => () => onUnmountRef.current?.(), []);

  // 关窗握手经注册表同步回写;卸载(切 tab / 切 mode / 重挂载)时也同步回写一次再停用。
  // 父组件的卸载清理先于子组件 <Milkdown/> 里的 editor.destroy(),此时仍可取全文。
  useEffect(() => {
    const unregister = registerEditorWriteBack(tabId, () => writeBackRef.current?.writeBack());
    const unregisterRoot = registerEditorRootRebind(() => {
      if (crepeRef.current) rebindMilkdownRoot(crepeRef.current);
    });
    return () => {
      unregister();
      unregisterRoot();
      const handle = writeBackRef.current;
      handle?.writeBack();
      handle?.dispose();
    };
    // tabId 挂载时取定(见 props 注释);依赖它重跑会在清理里提前回写并 dispose 编辑器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reloadEpoch 变了 → 这次的 value 是磁盘重载(还原 / 外部修改),可撤销地套用;其余变化(另一编辑器组)不进撤销栈。
  const appliedEpochRef = useRef(reloadEpoch);
  useEffect(() => {
    const undoable = reloadEpoch !== appliedEpochRef.current;
    appliedEpochRef.current = reloadEpoch;
    if (value !== undefined) writeBackRef.current?.applyExternal(value, undoable);
  }, [value, reloadEpoch]);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (readonly || !crepe) return;
    try {
      crepe.editor.ctx
        .get<{ setProps(props: { attributes: Record<string, string> }): void }, 'editorView'>('editorView')
        .setProps({ attributes: { 'aria-label': editorContentLabel(fileName, groupNumber) } });
    } catch {
      /* 尚未挂载(挂载时按 groupNumberRef 取值)/ 已拆除 */
    }
    // 只随组号变化:文件名 / 只读 / 语言变化走重挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupNumber]);

  return <Milkdown />;
}

export function MilkdownEditor(props: MilkdownEditorProps) {
  // Crepe theme 内部很多元素是相对单位(em/rem),容器 font-size 变,
  // ProseMirror 文本会跟着变。如果某些元素用 px 绝对值,可在
  // src/styles/milkdown-font-override.css(本文件顶部已导入)里 override
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);
  // 主题变化(含跟随系统的自动切换,可能发生在输入途中):mermaid 图的配色在渲染时定死,
  // 就地重画即可,不重挂载编辑器(会丢光标 / 滚动 / 尚未落 store 的输入)。
  const { resolved: theme } = useTheme();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const drawnThemeRef = useRef(theme);
  useEffect(() => {
    if (drawnThemeRef.current === theme) return;
    drawnThemeRef.current = theme;
    if (wrapperRef.current) redrawMermaidPreviews(wrapperRef.current);
  }, [theme]);
  // 语言变化:Crepe 浮层文案(斜杠菜单 / 工具条 / 链接框 / 代码块工具条 / 占位符)在创建时定死 → 用当前内容重挂载。
  // 不能就地换文案:Crepe 7.23 没有运行时更新 featureConfigs 的接口 —— 工具条 / 斜杠菜单把 config 传给 Vue 组件,
  // computed 不追踪普通对象(工具条的分组只算一次),代码块工具条文案在节点视图创建时读取;只有占位符读 ctx。
  // 代价:撤销历史丢失 —— 它是旧 EditorState 里 prosemirror-history 的插件状态,而 Milkdown 每个实例自建 schema,
  // 历史里的步骤 / 切片属于旧 schema,不能搬进新实例。故重挂前记下选区与焦点(onUnmount → relocaleRef),
  // 就绪后还原(handleReady);滚动位置照常按缓存恢复。查找条在 Provider 外,不随之重挂(查找框焦点 / 输入不丢)。
  // 语言只能在设置面板里切,不会与输入同时发生。key 必须放在 MilkdownProvider 上:只 key 内层的话 Provider
  // 里还留着旧 editorFactory,会先用旧挂载时的内容建一个临时编辑器(listener 仍连着 store)再建新的。
  const locale = useLocale();
  // 让 mermaid 预览能按内容反查到本编辑器里的代码块(连续输入时只渲染最后一版)。
  // 容器随 Provider 的 key 重建,故依赖 locale。
  useEffect(
    () => (wrapperRef.current ? registerMermaidRoot(wrapperRef.current) : undefined),
    [locale],
  );

  // 视图状态按 tab 保留(BDD: src/__tests__/editor-view-state/):滚动位置随滚动记下,编辑器就绪后恢复 ——
  // 切 tab / 切 Edit·Preview 都不跳回顶部(外部修改 / 还原就地套用,不重挂)。撤销历史在 ProseMirror 插件
  // state 里,跨 Crepe 实例不复用。就绪时同时登记聚焦句柄(打开文件后焦点进编辑器,见 editor-focus-registry)。
  //
  // 切换 源码 / 编辑 / 预览(按模式重挂)时按源码行保留位置(VSCode:Markdown 预览与源码按行同步滚动):卸载时记下顶部
  // 可见的源码行与光标行,另一模式的视图挂载时取用 —— 优先于同模式的像素滚动缓存。BDD: src/__tests__/markdown-mode-position/
  const tabId = props.tabId;
  const viewMode = props.readonly ? 'preview' : 'edit';
  const unregisterFocusRef = useRef<(() => void) | null>(null);
  const unregisterRevealRef = useRef<(() => void) | null>(null);
  const unregisterOutlineRef = useRef<(() => void) | null>(null);
  const positionRef = useRef<MarkdownPositionHandle | null>(null);
  const unsubscribeFindRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      unregisterFocusRef.current?.();
      unregisterRevealRef.current?.();
      unregisterOutlineRef.current?.();
      unsubscribeFindRef.current?.();
      // tab 已关闭(先从 store 移除、随后卸载):查找状态不再保留,重新打开不恢复
      if (!useEditorStore.getState().tabs?.some((t) => t.id === tabId)) forgetMarkdownFindSession(tabId);
    },
    // tabId 挂载时取定(父按 tab id 换 key 重挂)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ⌘F 查找(对齐 VSCode 编辑器 / Markdown 预览查找;BDD: src/__tests__/markdown-find/)。查找条复用终端查找条(SearchApi 形状),
  // 匹配 / 高亮 / 当前匹配在 ProseMirror 插件里(markdown-find),计数经插件变化回调(含编辑文档后的重算)回到这里。
  // 查找条状态按 tab 保留(markdown-find 的 find session):切走再切回(含切 编辑·预览)恢复查找条、查找词、选项与高亮,
  // 不抢焦点(focusRequest 0 = 不是用户打开)。
  const [findOpen, setFindOpen] = useState(() => markdownFindSessionOf(tabId)?.open ?? false);
  const [findTerm, setFindTerm] = useState(() => markdownFindSessionOf(tabId)?.term ?? '');
  const [findOptions, setFindOptions] = useState<TerminalSearchOptions>(
    () => markdownFindSessionOf(tabId)?.options ?? DEFAULT_TERMINAL_SEARCH_OPTIONS,
  );
  const [findResult, setFindResult] = useState<MarkdownFindResult>({ count: 0, index: -1 });
  const [findFocusRequest, setFindFocusRequest] = useState(0);
  useEffect(
    () => saveMarkdownFindSession(tabId, { open: findOpen, term: findTerm, options: findOptions }),
    [tabId, findOpen, findTerm, findOptions],
  );
  const runFind = useCallback((term: string, options: TerminalSearchOptions) => {
    const view = getViewRef.current();
    if (!view) return;
    setMarkdownFindQuery(view, term ? { term, ...options } : null);
    if (wrapperRef.current) revealMarkdownFindMatch(view, wrapperRef.current);
  }, []);
  const stepFind = useCallback((step: 1 | -1) => {
    const view = getViewRef.current();
    if (!view) return;
    stepMarkdownFind(view, step);
    if (wrapperRef.current) revealMarkdownFindMatch(view, wrapperRef.current);
  }, []);
  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindFocusRequest((n) => n + 1);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindFocusRequest(0); // 之后由 F3 / ⌘G 重新显示时不抢焦点;⌘F 再递增
    const view = getViewRef.current();
    if (!view) return;
    setMarkdownFindQuery(view, null);
    focusEditorView(view); // 选区停在当前匹配上
  }, []);
  const findTermRef = useRef(findTerm);
  findTermRef.current = findTerm;
  const findOptionsRef = useRef(findOptions);
  findOptionsRef.current = findOptions;
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  /** 单行非空选区的文字(VSCode seedSearchStringFromSelection);正则模式下转义元字符。没有则 null。 */
  const selectionSeed = useCallback((): string | null => {
    const view = getViewRef.current();
    if (!view) return null;
    const { from, to } = view.state.selection;
    if (from === to) return null;
    const text = view.state.doc.textBetween(from, to, '\n', '');
    if (!text || text.includes('\n')) return null;
    return clampSearchQuery(findOptionsRef.current.regex ? escapeRegExp(text) : text);
  }, []);
  const searchApi = useMemo<SearchApi>(
    () => ({
      isOpen: findOpen,
      term: findTerm,
      options: findOptions,
      result: findResult,
      focusRequest: findFocusRequest,
      open: openFind,
      close: closeFind,
      next: () => stepFind(1),
      prev: () => stepFind(-1),
      setTerm: (term) => {
        setFindTerm(term);
        runFind(term, findOptionsRef.current);
      },
      setOptions: (options) => {
        setFindOptions(options);
        runFind(findTermRef.current, options);
      },
      clearActiveDecoration: () => {},
    }),
    [findOpen, findTerm, findOptions, findResult, findFocusRequest, openFind, closeFind, stepFind, runFind],
  );
  // 计数文案与代码编辑器查找面板一致(「3 / 154」/「无结果」/「1000+」;空查找词不显示)
  const formatFindResult = useCallback(
    (r: MarkdownFindResult) =>
      formatFindCount({ empty: !findTermRef.current, total: r.count, current: r.index + 1, capped: r.count >= FIND_MATCH_LIMIT }),
    [],
  );
  // 查找类命令经命令注册表分发(可改键;外层带 MARKDOWN_EDITOR_ATTR → editorFocus 成立,见 editor-text-commands),
  // 经 markdown-find-registry 转到这里。代码块里的 CodeMirror 不算 editorFocus,保留其自带的查找键。
  // 「查找」(默认 ⌘F):打开查找条(已打开则重新聚焦并全选查找词)。焦点在正文且有单行选区 → 选区文字带入查找框并查找;否则关闭后
  // 重开沿用上次的查找词与选项重新查(VSCode 同)。
  // 「查找下一个 / 上一个」(默认 F3 / ⇧F3,mac 另有 ⌘G / ⇧⌘G):正文与查找框里都跳下一个 / 上一个;查找条已关则用上次的查找词
  //(没有则取选区)重新显示查找条(焦点不动)再跳 —— VSCode 同;没有可查的词时同「查找」打开查找条。
  // inBody:焦点在正文里(选区文字才带入查找框)
  const startFind = useCallback(
    (inBody: boolean) => {
      const seed = inBody ? selectionSeed() : null;
      if (seed) {
        setFindTerm(seed);
        runFind(seed, findOptionsRef.current);
      } else if (!findOpen && findTermRef.current) {
        runFind(findTermRef.current, findOptionsRef.current);
      }
      openFind();
    },
    [findOpen, openFind, runFind, selectionSeed],
  );
  const startFindRef = useRef(startFind);
  startFindRef.current = startFind;
  const stepFromCommand = useCallback(
    (step: 1 | -1, inBody: boolean) => {
      let term = findTermRef.current;
      if (!term) {
        term = (inBody ? selectionSeed() : null) ?? '';
        if (!term) {
          openFind();
          return;
        }
        setFindTerm(term);
      }
      const view = getViewRef.current();
      if (!view) return;
      // 查询已在(查找条开着且词没换)直接跳;否则先只高亮不动选区,再从选区起跳
      if (!findOpen || term !== findTermRef.current) {
        setMarkdownFindQuery(view, { term, ...findOptionsRef.current }, { select: false });
      }
      setFindOpen(true);
      stepFind(step);
    },
    [findOpen, openFind, selectionSeed, stepFind],
  );
  const stepFromCommandRef = useRef(stepFromCommand);
  stepFromCommandRef.current = stepFromCommand;
  // layout 清理:此时 DOM 仍在文档里(量得到位置),Crepe 尚未销毁。tab 已关闭 / 已改名(旧 id 不在了)不记。
  useLayoutEffect(
    () => () => {
      const el = wrapperRef.current;
      const position = positionRef.current;
      if (!el || !position || !useEditorStore.getState().tabs?.some((t) => t.id === tabId)) return;
      const anchor = position.anchor(el);
      if (anchor) saveMarkdownModeAnchor(tabId, { mode: viewMode, ...anchor }, groupId);
    },
    // tabId / 模式挂载时取定(父按 tab id + 模式换 key 重挂)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const getViewRef = useRef<() => EditorView | null>(() => null);
  const relocaleRef = useRef<RelocaleSnapshot | null>(null);
  // Crepe 卸载而本组件仍在 = Provider 按 locale 重挂(切 tab / 模式时本组件整个卸载,记下的状态随之丢弃)
  const handleCrepeUnmount = useCallback(() => {
    const view = getViewRef.current();
    getViewRef.current = () => null;
    const selection = view?.state?.selection;
    if (!view?.dom || !selection) return; // 未就绪 / 已拆除
    relocaleRef.current = {
      anchor: selection.anchor,
      head: selection.head,
      focused: view.dom.contains(view.dom.ownerDocument.activeElement),
    };
  }, []);
  const restoringScrollRef = useRef(false);
  const groupId = useEditorGroupId();
  // 查找 / 查找下一个·上一个(按键、菜单「编辑 → 查找」、命令面板)转到这里(BDD: src/__tests__/editor-find-keybindings/)
  useEffect(() => {
    const inBody = (): boolean => {
      const el = wrapperRef.current;
      return el?.contains(el.ownerDocument.activeElement) ?? false;
    };
    return registerMarkdownFind(tabId, groupId, {
      open: () => startFindRef.current(inBody()),
      step: (direction) => stepFromCommandRef.current(direction, inBody()),
    });
  }, [tabId, groupId]);
  const onViewReadyRef = useRef(props.onViewReady);
  onViewReadyRef.current = props.onViewReady;
  const handleReady = useCallback<OnEditorReady>(
    (focus, position, getView) => {
      positionRef.current = position;
      getViewRef.current = getView;
      unsubscribeFindRef.current?.();
      const view = getView();
      unsubscribeFindRef.current = view ? onMarkdownFindChange(view, setFindResult) : null;
      // 恢复的查找状态(切回 tab / 切模式 / 改语言重挂):重新高亮,不动选区、不滚动(滚动随后按视图状态恢复)
      if (view && findOpenRef.current && findTermRef.current) {
        setMarkdownFindQuery(view, { term: findTermRef.current, ...findOptionsRef.current }, { select: false });
      }
      const el = wrapperRef.current;
      const anchor = takeMarkdownModeAnchor(tabId, viewMode, groupId);
      // 恢复期间(到下一帧补齐为止)的滚动是中间值(内容尚未撑开被夹小等),不记进缓存,免得覆盖要恢复的值
      if (el && anchor) {
        restoringScrollRef.current = true;
        position.scrollToLine(el, anchor.topLine);
        // 下一帧:代码块 / mermaid 等节点视图可能才撑开高度,再对齐一次;光标也放到这一帧 —— Milkdown 列表项节点视图
        // 挂载时记下选区、在挂载后的下一帧恢复(list-item-block view),早于此设置的光标会被它改回文档开头。
        requestAnimationFrame(() => {
          if (anchor.cursorLine !== undefined) position.setCursorLine(anchor.cursorLine);
          position.scrollToLine(el, anchor.topLine);
          restoringScrollRef.current = false;
        });
      } else {
        const top = markdownScrollTopOf(tabId, groupId);
        if (el && top !== undefined) {
          restoringScrollRef.current = true;
          el.scrollTop = top;
          requestAnimationFrame(() => {
            if (el.scrollTop !== top) el.scrollTop = top;
            restoringScrollRef.current = false;
          });
        }
      }
      // 语言切换重挂:还原选区与焦点。放在下一帧(排在上面的滚动恢复之后):列表项节点视图挂载后的下一帧会改回选区(同上)
      const relocale = relocaleRef.current;
      relocaleRef.current = null;
      if (relocale) {
        requestAnimationFrame(() => {
          const current = getView();
          if (!current) return;
          try {
            restoreRelocaleSnapshot(current, relocale);
            // 查找条开着:上面就绪时按新实例的初始选区(文档开头)算出的当前匹配是 1 / N,而下一次 Enter 从还原后的选区起跳
            // → 按还原后的选区重算当前匹配(不动选区),计数 / 高亮与下一步一致
            if (findOpenRef.current && findTermRef.current) {
              setMarkdownFindQuery(current, { term: findTermRef.current, ...findOptionsRef.current }, { select: false });
            }
          } catch {
            /* 已拆除 */
          }
        });
      }
      unregisterFocusRef.current?.();
      unregisterFocusRef.current = registerEditorFocus(tabId, focus, groupId);
      // 在文件中查找等「打开并定位」:登记在滚动位置恢复之后,待兑现的定位排在恢复的那一帧之后(见 markdown-reveal-registry)
      unregisterRevealRef.current?.();
      unregisterRevealRef.current = registerMarkdownReveal(
        tabId,
        (target) => (wrapperRef.current ? position.reveal(wrapperRef.current, target) : null),
        groupId,
        () => {
          const anchor = wrapperRef.current ? position.anchor(wrapperRef.current) : null;
          return anchor ? (anchor.cursorLine ?? anchor.topLine) : null;
        },
      );
      // 转到符号(⇧⌘O)/ 侧栏大纲:按标题序号定位、读出当前节(BDD: src/__tests__/markdown-outline/)
      unregisterOutlineRef.current?.();
      unregisterOutlineRef.current = registerMarkdownOutline(
        tabId,
        groupId,
        createPmOutlineHandle(() => getView() as unknown as PmOutlineView | null, () => wrapperRef.current, viewMode === 'preview'),
      );
      onViewReadyRef.current?.();
    },
    [tabId, viewMode, groupId],
  );
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!restoringScrollRef.current) saveMarkdownScrollTop(tabId, e.currentTarget.scrollTop, groupId);
    },
    [tabId, groupId],
  );

  // ref 跟踪最新 onLinkClick:外层 click handler 不重建,内部读最新值。
  const onLinkClickRef = useRef(props.onLinkClick);
  onLinkClickRef.current = props.onLinkClick;

  // 点击 <a>(Crepe 渲染的 markdown link、mermaid 图 `click` 产出的 SVG 链接):
  //   - 永远吞掉默认行为 —— 只读视图 / 预览面板里的 <a> 默认会把整个应用窗口导航到 href;
  //   - Edit:仅修饰键 click 跳转,普通 click 留给 ProseMirror 定位光标(IDE 通用约定,issue #25);
  //   - Preview(只读)与链接气泡里的地址:普通 click 即跳转。
  // 鼠标与键盘(Cmd/Ctrl+Enter)两条路径定位到 <a> 后的共同收尾:取 href、吞掉默认行为、
  // 交给 onLinkClick。
  const activateLink = useCallback(
    (a: Element | null, e: React.SyntheticEvent): void => {
      // SVG <a> 的地址在 xlink:href 上
      const href = a?.getAttribute('href') ?? a?.getAttribute('xlink:href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      onLinkClickRef.current?.(href);
    },
    [],
  );

  const readonly = props.readonly ?? false;
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element | null)?.closest('a') ?? null;
    if (!a) return;
    e.preventDefault();
    if (readonly || e.metaKey || e.ctrlKey || a.classList.contains('link-display')) {
      activateLink(a, e);
    }
  }, [activateLink, readonly]);

  // 安全(L1):中键点链接在 Chromium 里不触发 click,只触发 auxclick,其默认行为是「在后台标签打开」——
  // Electron 把它交给 windowOpenHandler(只读预览里实测 file: / co: / https: 链接都会走到),绕过上面的
  // activateLink → resolveLink → 白名单外部打开。中键与左键同语义;其它键(右键菜单等)不当作打开。
  const handleAuxClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 1) return;
    handleClick(e);
  }, [handleClick]);

  // a11y(A152):Cmd/Ctrl+click 跳转的键盘等价 —— Cmd/Ctrl+Enter。键盘用户无法用鼠标修饰键
  // 点击链接;用修饰键(非裸 Enter)避免与可编辑 ProseMirror 的换行冲突。链接定位优先 event
  // target(链接获焦时),退回当前选区 anchorNode 所在的 <a>(caret 落在链接文本里时)。
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    const fromTarget = (e.target as HTMLElement | null)?.closest?.('a') ?? null;
    let a: HTMLAnchorElement | null = fromTarget as HTMLAnchorElement | null;
    if (!a) {
      const sel = (e.currentTarget.ownerDocument ?? document).getSelection();
      const node = sel?.anchorNode ?? null;
      const el =
        node instanceof HTMLElement ? node : (node?.parentElement ?? null);
      a = el?.closest('a') ?? null;
    }
    activateLink(a, e);
  }, [activateLink]);

  // 悬停链接显示真实地址(浏览器状态栏 / VSCode Markdown 预览悬停的对应物):链接文字可以与地址完全不同
  // (`[https://good.example](https://evil.example)`)。title 挂在外层容器上(在 ProseMirror 的 DOM 之外,改它不触发
  // ProseMirror 的 DOM 观察与重新解析);<a> 自带 title(Markdown `"标题"`)时浏览器显示它自己的,真实地址仍由外链确认框给出。
  // 不可见 / 双向控制字符可见化(同授权弹窗)。
  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element | null)?.closest?.('a') ?? null;
    const href = a?.getAttribute('href') ?? a?.getAttribute('xlink:href');
    if (href) e.currentTarget.title = visibleUntrustedText(href, MAX_EXTERNAL_URL_LEN);
    else e.currentTarget.removeAttribute('title');
  }, []);
  const handleMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.removeAttribute('title');
  }, []);

  // 链接气泡的「复制链接」(Crepe LinkTooltip 的 .link-preview .link-icon):上游处理器挂在该图标的
  // pointerdown 上,且只在 navigator.clipboard 存在时复制 —— PROD 的 sandboxSweep 把它清掉了,点了
  // 没反应;onCopyLink 配置项只是复制成功后的回调,改不了复制本身。故在外层捕获阶段截下该事件
  // (上游处理器不再执行),改走启动时缓存的剪贴板;失败给可见提示(同其它复制入口)。
  const handlePointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const icon = (e.target as Element | null)?.closest?.('.link-preview .link-icon');
    if (!icon) return;
    e.preventDefault();
    e.stopPropagation();
    // 取气泡显示的文字(= 链接 mark 的原地址),不取 href:上游 sanitizeLinkHref 会把白名单外 scheme 的
    // href 置空(盘符路径 / co: / vscode: 已由 scripts/vite-milkdown-link-href.ts 放行)。
    const link = icon.closest('.link-preview')?.querySelector('a.link-display')?.textContent;
    if (link) void copyToClipboardOrNotify(link, t('panels.editor.link.copy_failed'));
  }, []);

  return (
    // 外层不滚动:查找条浮在右上角不随正文滚动。@container/terminal:复用的终端查找条按此名的容器查询收缩窄宽布局。
    <div className="@container/terminal relative h-full w-full" {...{ [MARKDOWN_EDITOR_ATTR]: '' }}>
      <MilkdownProvider key={locale}>
      <div
        ref={wrapperRef}
        className="h-full w-full overflow-auto"
        // --crepe-base-font-size:Crepe 代码块占位层等按它算字号(覆写 CSS 让 .milkdown 继承此值)
        style={{ fontSize: `${fontSize}px`, '--crepe-base-font-size': `${fontSize}px` } as React.CSSProperties}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onKeyDown={handleKeyDown}
        onPointerDownCapture={handlePointerDownCapture}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
        onScroll={handleScroll}
      >
        <CrepeEditor {...props} onReady={handleReady} onUnmount={handleCrepeUnmount} />
      </div>
      </MilkdownProvider>
      {findOpen && (
        <TerminalSearchBar
          searchApi={searchApi}
          onClose={closeFind}
          formatResult={formatFindResult}
          // 与代码编辑器查找面板一致:标签「查找」、↑ / ↓ 翻共享的查找历史
          label={t('editor.cm.find')}
          history={editorFindHistory}
        />
      )}
    </div>
  );
}
