import type { EditorView } from '@codemirror/view';
import { pathEquals } from '@/lib/path-cross';
import { useDebugStore, type DebugSessionShadow } from '@/stores/debug.store';
import { useEditorStore } from '@/stores/editor.store';
import { isMarkdownPath } from '../editor-path-utils';
import { debugDocVersion, setDebugDecorations } from './debug-decorations';
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

// 每个 view 上次应用的装饰签名。同步订阅整个 editor store(任一 tab 敲键都触发),签名没变的 view 不再派发事务
//(文档本身变了的那个 view 会重贴,其余 view 跳过)。
const appliedSignatures = new WeakMap<EditorView, string>();

function applyDecorations(
  view: EditorView,
  breakpointLines: readonly number[],
  execLine: number | null,
): void {
  // 含文档版本:文档变过(装饰可能已被映射走 / 清空)就必须按行号重贴,不能因行号没变而跳过。
  const signature = `${debugDocVersion(view)}|${execLine ?? ''}|${breakpointLines.join(',')}`;
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

export function startDebugDecorationSync(): () => void {
  refCount += 1;
  if (unsubscribeDebug === null && unsubscribeEditor === null) {
    unsubscribeDebug = useDebugStore.subscribe(syncDebugDecorations);
    unsubscribeEditor = useEditorStore.subscribe(syncDebugDecorations);
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
