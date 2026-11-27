// 「编辑器里的 Markdown 标题符号」的目标解析与定位(转到符号 ⇧⌘O / Quick Open `@` 与侧栏大纲共用):
// - 源码模式(CodeMirror):按源码行 —— 光标所在行 → 当前节;定位 = scrollToLine(光标到标题行首并居中);
// - 编辑 / 预览(Milkdown):按标题序号(markdown-outline-registry 的视图句柄)。
// 导航记录(后退 / 前进):确认跳转时记「原位置 → 标题」(同转到行);预览与取消恢复不记。Milkdown 视图的光标不进导航栈
//(既有行为:导航栈只记 CodeMirror 光标,Markdown 编辑 / 预览只记文件)。
// 本模块在启动路径上(Quick Open / 侧栏):scrollToLine 动态 import,不静态引入编辑引擎。
// BDD: src/__tests__/markdown-outline/

import type { EditorView } from '@codemirror/view';
import type { EditorSelection, StateEffect } from '@codemirror/state';
import { groupActiveTabIdOf, liveEditorViewOf, useEditorStore, usesMilkdownEngine } from '@/stores/editor.store';
import { isMarkdownPath } from './editor-path-utils';
import { isImagePreviewPath } from './editor-image';
import { findEditorFileTabById } from './editor-tab-lookup';
import { navigationSelectionOf, notifyEditorSelection, withoutNavigationRecording } from './navigation-history';
import { markdownOutlineHandleOf, type MarkdownOutlineHandle } from './markdown-outline-registry';
import { symbolOrdinalAtLine, type MarkdownOutline, type MarkdownSymbol } from './markdown-outline-model';

type ScrollToLine = typeof import('./scrollToLine').scrollToLine;

let scrollToLineModule: Promise<ScrollToLine> | null = null;

/** scrollToLine(依赖 @codemirror/view)按需加载;失败不缓存。 */
export function loadScrollToLine(): Promise<ScrollToLine> {
  scrollToLineModule ??= import('./scrollToLine').then(
    (m) => m.scrollToLine,
    (err: unknown) => {
      scrollToLineModule = null;
      throw err;
    },
  );
  return scrollToLineModule;
}

interface TargetBase {
  readonly groupId: string;
  readonly tabId: string;
  readonly filePath: string;
  /** 源码文本(符号据此解析)。 */
  readonly content: string;
}

/**
 * 符号目标:
 * - none = 没有文本编辑器(无 tab / 图片 / 视图未挂载);
 * - unsupported = 有文本编辑器但不提供符号(非 Markdown;本项目无语言服务);
 * - codemirror / milkdown = 可跳转。
 */
export type SymbolTarget =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'unsupported' } & TargetBase)
  | ({ readonly kind: 'codemirror'; readonly view: EditorView } & TargetBase)
  | ({ readonly kind: 'milkdown'; readonly handle: MarkdownOutlineHandle } & TargetBase);

const NONE: SymbolTarget = { kind: 'none' };

/** 编辑器组 groupId 的活动 tab 作为符号目标(groupId 缺省 → none)。 */
export function resolveSymbolTarget(groupId: string | undefined): SymbolTarget {
  if (groupId === undefined) return NONE;
  const state = useEditorStore.getState();
  const tabId = groupActiveTabIdOf(state, groupId);
  if (tabId === null) return NONE;
  const tab = findEditorFileTabById(state.tabs, tabId);
  if (!tab || isImagePreviewPath(tab.filePath)) return NONE;
  const base: TargetBase = { groupId, tabId, filePath: tab.filePath, content: tab.content };
  if (!isMarkdownPath(tab.filePath)) return { kind: 'unsupported', ...base };
  if (usesMilkdownEngine(tab.filePath, tab)) {
    const handle = markdownOutlineHandleOf(tabId, groupId);
    return handle ? { kind: 'milkdown', handle, ...base } : NONE;
  }
  const view = liveEditorViewOf(tabId, groupId);
  return view && view.dom.isConnected ? { kind: 'codemirror', view, ...base } : NONE;
}

/** 光标(源码 / 编辑)或视口顶部(预览)所在的节:符号序号;第一个标题之前 / 未就绪 → -1。 */
export function currentSymbolOrdinal(target: SymbolTarget, outline: MarkdownOutline): number {
  if (target.kind === 'codemirror') {
    const { state } = target.view;
    const head = Math.min(state.selection.main.head, state.doc.length);
    return symbolOrdinalAtLine(outline, state.doc.lineAt(head).number);
  }
  if (target.kind === 'milkdown') {
    const ordinal = target.handle.currentHeading();
    return ordinal === null ? -1 : Math.min(ordinal, outline.flat.length - 1);
  }
  return -1;
}

/** 进入选择器时记下的视图状态(取消时恢复)。 */
export interface SymbolTargetSnapshot {
  readonly restore: () => void;
  /** CodeMirror:原光标(确认跳转时先记进导航历史)。 */
  readonly selection?: EditorSelection;
}

export function snapshotSymbolTarget(target: SymbolTarget): SymbolTargetSnapshot {
  if (target.kind === 'milkdown') return { restore: target.handle.snapshot() };
  if (target.kind !== 'codemirror') return { restore: () => {} };
  const { view } = target;
  const selection = view.state.selection;
  const scroll: StateEffect<unknown> = view.scrollSnapshot();
  return {
    selection,
    restore: () => {
      if (!view.dom.isConnected) return;
      try {
        withoutNavigationRecording(() => view.dispatch({ selection, effects: scroll }));
      } catch {
        // 期间文档被替换得比原选区短(外部同步)→ 不恢复
      }
    },
  };
}

export interface RevealSymbolOptions {
  /** 把焦点交给编辑器。 */
  readonly focus: boolean;
  /**
   * 记进导航历史(确认跳转):CodeMirror 先记 before(缺省当前光标)再记标题位置;false = 预览,不记。
   */
  readonly record: boolean;
  readonly before?: EditorSelection;
}

/** 定位到符号(异步:CodeMirror 的 scrollToLine 按需加载)。返回是否已定位。 */
export async function revealSymbol(target: SymbolTarget, symbol: MarkdownSymbol, opts: RevealSymbolOptions): Promise<boolean> {
  if (target.kind === 'milkdown') return target.handle.revealHeading(symbol.ordinal, { focus: opts.focus });
  if (target.kind !== 'codemirror') return false;
  const { view } = target;
  let scrollToLine: ScrollToLine;
  try {
    scrollToLine = await loadScrollToLine();
  } catch {
    return false;
  }
  if (!view.dom.isConnected || symbol.line > view.state.doc.lines) return false;
  const apply = () => scrollToLine(view, symbol.line, undefined, undefined, { focus: false });
  if (opts.record) {
    notifyEditorSelection(target.groupId, target.tabId, navigationSelectionOf(view.state.doc, opts.before ?? view.state.selection));
    apply();
  } else {
    withoutNavigationRecording(apply);
  }
  if (opts.focus) view.focus();
  return true;
}
