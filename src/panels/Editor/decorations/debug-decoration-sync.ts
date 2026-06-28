import type { EditorView } from '@codemirror/view';
import { pathEquals } from '@/lib/path-cross';
import { useDebugStore, type DebugSessionShadow } from '@/stores/debug.store';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { isMarkdownPath } from '../editor-path-utils';
import { setDebugDecorations } from './debug-decorations';

let unsubscribeDebug: (() => void) | null = null;
let unsubscribeEditor: (() => void) | null = null;
let refCount = 0;

function findTabById(tabs: readonly EditorTab[], tabId: string): EditorTab | null {
  for (const tab of tabs) {
    if (tab.id === tabId) return tab;
  }
  return null;
}

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

function clearView(view: EditorView): void {
  setDebugDecorations(view, { breakpointLines: [], execLine: null });
}

function syncDebugDecorations(): void {
  const editorState = useEditorStore.getState();
  const debugState = useDebugStore.getState();
  const activeSession =
    debugState.activeSessionId === null
      ? undefined
      : debugState.sessions.get(debugState.activeSessionId);

  for (const [tabId, view] of editorState.viewRefs) {
    const tab = findTabById(editorState.tabs, tabId);
    if (tab === null || tab.filePath === null || isMarkdownPath(tab.filePath)) {
      clearView(view);
      continue;
    }

    const filePath = tab.filePath;
    setDebugDecorations(view, {
      breakpointLines: breakpointLinesForTab(debugState.sessions, filePath),
      execLine: execLineForTab(activeSession, filePath),
    });
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
