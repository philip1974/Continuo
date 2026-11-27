// 缩进命令与状态栏缩进项(VSCode editor.action.indentUsingSpaces / indentUsingTabs / detectIndentation / indentationToSpaces /
// indentationToTabs,editorStatus showIndentationPicker)。作用于触发窗口编辑器组的活动文本 tab(状态栏点击 = 该 tab)。
// - 使用空格 / Tab 缩进:再选宽度 1..8,对当前文档生效(会话内按文档记住,不写设置;VSCode model.updateOptions 同)。
// - 从内容中检测缩进方式:按当前内容重新推断(设置关了检测也推断)。
// - 转换缩进:整篇行首缩进按当前宽度转换,一次撤销撤回;之后文档改用空格 / tab。
// BDD: src/__tests__/editor-indentation/

import type { EditorView } from '@codemirror/view';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useEditorStore } from '@/stores/editor.store';
import { activeGroupTab } from '@/panels/Editor/editor-commands';
import { isImagePreviewPath } from '@/panels/Editor/editor-image';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import { flushEditorWriteBacks } from '@/panels/Editor/editor-writeback-registry';
import {
  convertIndentationText,
  creationIndentOptions,
  detectIndentationFromContent,
  ensureTabIndentation,
  indentationConversionChanges,
  setTabIndentation,
  type IndentOptions,
} from '@/panels/Editor/editor-indentation';
import { encodingPickItems } from './encoding-picks';
import { showEncodingPicker as show, useEncodingPickerStore } from './store';

export const INDENT_USING_SPACES_COMMAND_ID = 'editor.action.indentUsingSpaces';
export const INDENT_USING_TABS_COMMAND_ID = 'editor.action.indentUsingTabs';
export const DETECT_INDENTATION_COMMAND_ID = 'editor.action.detectIndentation';
export const INDENTATION_TO_SPACES_COMMAND_ID = 'editor.action.indentationToSpaces';
export const INDENTATION_TO_TABS_COMMAND_ID = 'editor.action.indentationToTabs';

function textTab(tabId: string | undefined) {
  const tab =
    tabId === undefined ? activeGroupTab() : findEditorFileTabById(useEditorStore.getState().tabs, tabId);
  return tab && !isImagePreviewPath(tab.filePath) ? tab : null;
}

function indentationOf(tab: { readonly id: string; readonly filePath: string; readonly content: string }): IndentOptions {
  return ensureTabIndentation(tab.id, tab.filePath, tab.content);
}

/** 状态栏缩进项:动作列表。 */
export function openIndentationPicker(tabId?: string): void {
  const tab = textTab(tabId);
  if (!tab) return;
  show({ kind: 'indent', tabId: tab.id });
}

/** 使用空格 / Tab 缩进:选宽度(初始选中当前宽度)。 */
export function openIndentSizePicker(insertSpaces: boolean, tabId?: string): void {
  const tab = textTab(tabId);
  if (!tab) return;
  const request = { kind: 'indent-size', tabId: tab.id, insertSpaces } as const;
  const current = indentationOf(tab);
  show(
    request,
    encodingPickItems(request, { indent: current, configuredTabSize: creationIndentOptions(tab.filePath).tabSize }).selectedIndex,
  );
}

export function detectIndentation(tabId?: string): void {
  const target = textTab(tabId);
  if (!target) return;
  flushEditorWriteBacks([target.id]);
  const tab = textTab(target.id);
  if (!tab) return;
  setTabIndentation(tab.id, detectIndentationFromContent(tab.filePath, tab.content));
}

/**
 * 将缩进转换为空格 / 制表符(按当前宽度)。编辑器视图挂着 → 一次事务(撤销一步撤回,userEvent 不与前后输入合并);
 * 没有视图(如 Markdown 编辑模式)→ 改 store 内容。之后文档改用空格 / tab,宽度不变。
 */
export function convertIndentation(toSpaces: boolean, tabId?: string): void {
  const target = textTab(tabId);
  if (!target) return;
  flushEditorWriteBacks([target.id]);
  const tab = textTab(target.id);
  if (!tab) return;
  const { tabSize } = indentationOf(tab);
  const view = useEditorStore.getState().viewRefs.get(tab.id);
  if (view) {
    const changes = indentationConversionChanges(docLines(view), tabSize, toSpaces);
    if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.indent', scrollIntoView: false });
  } else {
    const next = convertIndentationText(tab.content, tabSize, toSpaces);
    if (next !== tab.content) useEditorStore.getState().updateContent(tab.id, next);
  }
  setTabIndentation(tab.id, { tabSize, insertSpaces: toSpaces });
}

function* docLines(view: EditorView): Generator<{ from: number; text: string }> {
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    yield { from: line.from, text: line.text };
  }
}

/** 缩进选择器里确定了一项。 */
export function acceptIndentationPick(
  request: { readonly kind: 'indent'; readonly tabId: string } | { readonly kind: 'indent-size'; readonly tabId: string; readonly insertSpaces: boolean },
  id: string,
): void {
  const store = useEncodingPickerStore.getState();
  if (request.kind === 'indent-size') {
    store.close();
    const size = Number(id);
    if (!Number.isInteger(size) || size < 1 || size > 8) return;
    if (!textTab(request.tabId)) return;
    setTabIndentation(request.tabId, { tabSize: size, insertSpaces: request.insertSpaces });
    return;
  }
  switch (id) {
    case INDENT_USING_SPACES_COMMAND_ID:
      return openIndentSizePicker(true, request.tabId);
    case INDENT_USING_TABS_COMMAND_ID:
      return openIndentSizePicker(false, request.tabId);
    case DETECT_INDENTATION_COMMAND_ID:
      store.close();
      return detectIndentation(request.tabId);
    case INDENTATION_TO_SPACES_COMMAND_ID:
      store.close();
      return convertIndentation(true, request.tabId);
    case INDENTATION_TO_TABS_COMMAND_ID:
      store.close();
      return convertIndentation(false, request.tabId);
  }
}

export function indentationCommandSpecs(): CommandSpec[] {
  return [
    {
      id: INDENT_USING_SPACES_COMMAND_ID,
      title: 'Indent Using Spaces',
      titleKey: 'commands.editor.indent_using_spaces.title',
      fn: () => openIndentSizePicker(true),
    },
    {
      id: INDENT_USING_TABS_COMMAND_ID,
      title: 'Indent Using Tabs',
      titleKey: 'commands.editor.indent_using_tabs.title',
      fn: () => openIndentSizePicker(false),
    },
    {
      id: DETECT_INDENTATION_COMMAND_ID,
      title: 'Detect Indentation from Content',
      titleKey: 'commands.editor.detect_indentation.title',
      fn: () => detectIndentation(),
    },
    {
      id: INDENTATION_TO_SPACES_COMMAND_ID,
      title: 'Convert Indentation to Spaces',
      titleKey: 'commands.editor.indentation_to_spaces.title',
      fn: () => convertIndentation(true),
    },
    {
      id: INDENTATION_TO_TABS_COMMAND_ID,
      title: 'Convert Indentation to Tabs',
      titleKey: 'commands.editor.indentation_to_tabs.title',
      fn: () => convertIndentation(false),
    },
  ];
}
