import type { EditorView } from '@codemirror/view';
import { pathEquals } from '@/lib/path-cross';
import { useDebugStore, type DebugSessionShadow } from '@/stores/debug.store';
import { useEditorStore } from '@/stores/editor.store';
import { isMarkdownPath } from '../editor-path-utils';
import { setDebugDecorations } from './debug-decorations';
import { findEditorFileTabById } from '../editor-tab-lookup';

let unsubscribeDebug: (() => void) | null = null;
let unsubscribeEditor: (() => void) | null = null;
let refCount = 0;

function breakpointLinesForTab(
  sessions: ReadonlyMap<string, DebugSessionShadow>,
  filePath: string,
): number[] {
  const lines: number[] = [];
  for (const session of sessions.values()) {
    for (const breakpoint of session.breakpoints) {
      if (pathEquals(breakpoint.file, filePath)) lines.push(breakpoint.line);
    }
  }
  return lines;
}

function execLineForTab(
  session: DebugSessionShadow | undefined,
  filePath: string,
): number | null {
  const stopped = session?.stopped;
  if (
    stopped?.file === undefined ||
    stopped.line === undefined ||
    !pathEquals(stopped.file, filePath)
  ) {
    return null;
  }
  return stopped.line;
}

// 每个 view 上次应用的装饰签名。签名没变就不再派发事务(chromeVersion 也随 dirty 翻转 bump 等)。
const appliedSignatures = new WeakMap<EditorView, string>();

function applyDecorations(
  view: EditorView,
  breakpointLines: readonly number[],
  execLine: number | null,
): void {
  // 只看行号:文档变化时的重贴由 view 侧的 StateField 自己完成(见 debug-decorations)。
  const signature = `${execLine ?? ''}|${breakpointLines.join(',')}`;
  if (appliedSignatures.get(view) === signature) return;
  appliedSignatures.set(view, signature);
  setDebugDecorations(view, { breakpointLines, execLine });
}

const NO_BREAKPOINT_LINES: readonly number[] = [];

function clearView(view: EditorView): void {
  applyDecorations(view, NO_BREAKPOINT_LINES, null);
}

function syncDebugDecorations(): void {
  const editorState = useEditorStore.getState();
  const debugState = useDebugStore.getState();
  const activeSession =
    debugState.activeSessionId === null
      ? undefined
      : debugState.sessions.get(debugState.activeSessionId);

  for (const [tabId, view] of editorState.viewRefs) {
    const tab = findEditorFileTabById(editorState.tabs, tabId);
    if (tab === null || tab.filePath === null || isMarkdownPath(tab.filePath)) {
      clearView(view);
      continue;
    }

    const filePath = tab.filePath;
    applyDecorations(
      view,
      breakpointLinesForTab(debugState.sessions, filePath),
      execLineForTab(activeSession, filePath),
    );
  }
}

function clearAllViews(): void {
  for (const view of useEditorStore.getState().viewRefs.values()) {
    clearView(view);
  }
}

// perf E4:只在装饰输入真变化时才同步(每次同步 = 每 view 线性找 tab + 扫全部断点做路径比较,
// O(T²+T·B))。editor 侧:viewRefs(新开/关闭 view)或 chromeVersion(tab 增删/改名/改路径都经 store
// action bump;按键在已脏 tab 不 bump)。debug 侧:activeSessionId,或某 session 的 breakpoints / stopped
// 引用变化(loadVariables、帧/作用域等无关更新保留原引用)。正文变化后的装饰重建由 view 侧 StateField
// 在 docChanged 时按行号完成(见 debug-decorations),不依赖 editor store 的正文通知。
type EditorDecorationInputs = Pick<
  ReturnType<typeof useEditorStore.getState>,
  'viewRefs' | 'chromeVersion'
>;

function editorDecorationInputsChanged(
  next: EditorDecorationInputs,
  prev: EditorDecorationInputs,
): boolean {
  return next.viewRefs !== prev.viewRefs || next.chromeVersion !== prev.chromeVersion;
}

type DebugDecorationInputs = Pick<
  ReturnType<typeof useDebugStore.getState>,
  'sessions' | 'activeSessionId'
>;

function debugDecorationInputsChanged(
  next: DebugDecorationInputs,
  prev: DebugDecorationInputs,
): boolean {
  if (next.activeSessionId !== prev.activeSessionId) return true;
  if (next.sessions === prev.sessions) return false;
  if (next.sessions.size !== prev.sessions.size) return true;
  for (const [id, session] of next.sessions) {
    const before = prev.sessions.get(id);
    if (
      before === undefined ||
      before.breakpoints !== session.breakpoints ||
      before.stopped !== session.stopped
    ) {
      return true;
    }
  }
  return false;
}

export function startDebugDecorationSync(): () => void {
  refCount += 1;
  if (unsubscribeDebug === null && unsubscribeEditor === null) {
    unsubscribeDebug = useDebugStore.subscribe((next, prev) => {
      if (debugDecorationInputsChanged(next, prev)) syncDebugDecorations();
    });
    unsubscribeEditor = useEditorStore.subscribe((next, prev) => {
      if (editorDecorationInputsChanged(next, prev)) syncDebugDecorations();
    });
    syncDebugDecorations();
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    refCount -= 1;
    if (refCount > 0) return;

    clearAllViews();
    unsubscribeDebug?.();
    unsubscribeEditor?.();
    unsubscribeDebug = null;
    unsubscribeEditor = null;
  };
}
