// Quick Open「转到行 / 列」模式(查询以 `:` 开头;⌃G 打开时预填)。对齐 VSCode GotoLineQuickAccessProvider:
// - 目标 = 触发窗口的编辑器组(commandEditorGroupId)的活动文本编辑器(CodeMirror 视图);没有(无 tab / 图片 / Markdown 编辑·预览)
//   → 提示「请先打开文本编辑器」;
// - 输入时实时预览(光标移到目标并居中,焦点留在输入框);Enter 确认跳转并把焦点交给编辑器;
// - Esc 取消 / 删掉 `:` 离开该模式 → 光标与滚动位置回到打开前(VSCode 同:未确认就恢复视图状态);
// - 行号越界夹到文档范围内(VSCode 对越界不跳;此处按产品要求夹取)。
// - 后退 / 前进的导航记录:预览与取消恢复不记;Enter 记「原位置 → 目标」(BDD: src/__tests__/editor-navigation-history/)。
// scrollToLine 依赖 @codemirror/view,动态 import(loadScrollToLine;Quick Open 在启动路径上,不把编辑器引擎拖进启动包)。
// BDD: src/__tests__/editor-goto-line/

import { useEffect, useMemo, useRef } from 'react';
import type { EditorView } from '@codemirror/view';
import type { EditorSelection, StateEffect } from '@codemirror/state';
import { useT } from '@/i18n';
import { groupActiveTabIdOf, liveEditorViewOf, useEditorStore } from '@/stores/editor.store';
import { commandEditorGroupId } from '@/panels/Editor/editor-groups-actions';
import {
  navigationSelectionOf,
  notifyEditorSelection,
  withoutNavigationRecording,
} from '@/panels/Editor/navigation-history';
import { loadScrollToLine } from '@/panels/Editor/markdown-symbol-navigation';
import { clampGotoLine, isGotoLineQuery, parseGotoLineQuery } from './goto-line';

interface GotoTarget {
  readonly view: EditorView;
  readonly groupId: string;
  readonly tabId: string;
  /** 进入该模式时的选区与滚动位置(取消时恢复)。 */
  readonly selection: EditorSelection;
  readonly scroll: StateEffect<unknown>;
}

/** 触发窗口的编辑器组里活动 tab 的 CodeMirror 视图(没有 → null)。 */
function resolveGotoTarget(): GotoTarget | null {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return null;
  const tabId = groupActiveTabIdOf(useEditorStore.getState(), groupId);
  if (tabId === null) return null;
  const view = liveEditorViewOf(tabId, groupId);
  if (!view || !view.dom.isConnected) return null;
  return { view, groupId, tabId, selection: view.state.selection, scroll: view.scrollSnapshot() };
}

function restoreTarget(target: GotoTarget): void {
  const { view } = target;
  if (!view.dom.isConnected) return;
  try {
    withoutNavigationRecording(() => view.dispatch({ selection: target.selection, effects: target.scroll }));
  } catch {
    // 期间文档被替换得比原选区短(外部同步)→ 不恢复
  }
}

export interface GotoLineState {
  /** 查询处于转到行模式(以 `:` 开头)。 */
  readonly active: boolean;
  /** 唯一一行的文案(VSCode 同:提示 / 「转到第 N 行」)。 */
  readonly message: string;
  /** 有可跳转的目标(Enter 生效)。 */
  readonly canAccept: boolean;
  /** 确认跳转:关闭 Quick Open,光标移到目标并聚焦编辑器。 */
  readonly accept: () => void;
}

export function useGotoLine(query: string, close: () => void): GotoLineState {
  const t = useT();
  const active = isGotoLineQuery(query);
  // 进入该模式时取一次目标与原位置(模式内不再变化)。
  const target = useMemo(() => (active ? resolveGotoTarget() : null), [active]);
  const acceptedRef = useRef(false);
  const request = active ? parseGotoLineQuery(query) : null;
  const resolved = target && request ? clampGotoLine(request, target.view.state.doc) : null;
  const line = resolved?.line;
  const column = resolved?.column;

  // 离开该模式 / Quick Open 关闭而未确认 → 回到原位置。
  useEffect(() => {
    if (!target) return;
    acceptedRef.current = false;
    loadScrollToLine().catch(() => {});
    return () => {
      if (!acceptedRef.current) restoreTarget(target);
    };
  }, [target]);

  // 实时预览:有目标 → 移过去(不抢焦点);输入变回无效 → 回到原位置。
  useEffect(() => {
    if (!target) return;
    if (line === undefined) {
      restoreTarget(target);
      return;
    }
    let cancelled = false;
    loadScrollToLine().then(
      (scrollToLine) => {
        if (!cancelled && target.view.dom.isConnected) {
          withoutNavigationRecording(() => scrollToLine(target.view, line, column, undefined, { focus: false }));
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [target, line, column]);

  const accept = (): void => {
    if (!target || line === undefined) return;
    acceptedRef.current = true;
    const { view } = target;
    close();
    void loadScrollToLine().then(
      (scrollToLine) => {
        if (!view.dom.isConnected) return;
        // 导航记录:先记打开前的位置(预览已移走光标,选区变化里的「变化前」不再是它),再由跳转记目标
        notifyEditorSelection(target.groupId, target.tabId, navigationSelectionOf(view.state.doc, target.selection));
        scrollToLine(view, line, column, undefined, { focus: false });
        // Modal 关闭时把焦点还给打开前的元素(可能不是编辑器,如从命令面板执行)→ 下一帧再交给编辑器。
        requestAnimationFrame(() => {
          if (view.dom.isConnected) view.focus();
        });
      },
      () => {},
    );
  };

  let message = '';
  if (active) {
    if (!target) message = t('quick_open.goto.no_editor');
    else if (line !== undefined)
      message =
        column !== undefined ? t('quick_open.goto.line_column', { line, column }) : t('quick_open.goto.line', { line });
    else {
      const doc = target.view.state.doc;
      const head = target.selection.main.head;
      const at = doc.lineAt(Math.min(head, doc.length));
      const params = { line: at.number, column: head - at.from + 1, max: doc.lines };
      message = doc.lines > 1 ? t('quick_open.goto.current', params) : t('quick_open.goto.current_single', params);
    }
  }
  return { active, message, canAccept: line !== undefined, accept };
}
