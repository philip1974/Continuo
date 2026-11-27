// 编码 / 行尾 / 缩进选择器的列表项(纯函数;VSCode editorStatus ChangeEncodingAction / ChangeEOLAction / showIndentationPicker、
// indentation.ts ChangeIndentationSizeAction 的 picks)。
// BDD: src/__tests__/editor-text-encoding/

import {
  isDecodableEncoding,
  TEXT_ENCODING_IDS,
  TEXT_ENCODINGS,
  type TextEncodingId,
} from '../../../electron/shared/text-encoding';
import type { LineEnding } from '@/panels/Editor/editor-encoding';
import type { IndentOptions } from '@/panels/Editor/editor-indentation';
import type { EncodingPickRequest } from './store';

export interface EncodingPickItem {
  /** 'reopen' / 'save'(第一步)、编码 id、'LF' / 'CRLF'。 */
  readonly id: string;
  /** 文案:第一步与行尾给 i18n key(labelKey),编码给显示名(label,不翻译,同 VSCode)。 */
  readonly label?: string;
  readonly labelKey?: string;
  /** 次要文字(编码 id,同 VSCode description)。 */
  readonly description?: string;
  /** 次要文字的 i18n key(缩进宽度的「已配置 / 默认 / 当前制表符大小」)。 */
  readonly descriptionKey?: string;
}

/**
 * 状态栏缩进项的动作(VSCode showIndentationPicker 的顺序;id = 命令 id,标题 = 命令标题)。VSCode 列表里的「更改制表符显示大小」
 *(indentSize 与 tabSize 分开)、「删除尾随空格」不在本次范围。
 */
export const INDENTATION_PICK_ACTIONS: readonly { readonly id: string; readonly labelKey: string }[] = [
  { id: 'editor.action.indentUsingSpaces', labelKey: 'commands.editor.indent_using_spaces.title' },
  { id: 'editor.action.indentUsingTabs', labelKey: 'commands.editor.indent_using_tabs.title' },
  { id: 'editor.action.detectIndentation', labelKey: 'commands.editor.detect_indentation.title' },
  { id: 'editor.action.indentationToSpaces', labelKey: 'commands.editor.indentation_to_spaces.title' },
  { id: 'editor.action.indentationToTabs', labelKey: 'commands.editor.indentation_to_tabs.title' },
];

/** 缩进宽度候选(VSCode 同:1..8)。 */
export const INDENT_SIZES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * 缩进宽度项:标注「已配置制表符大小」(= 设置值且 = 当前)/「默认制表符大小」(= 设置值)/「当前制表符大小」(= 当前);
 * 初始选中当前宽度(超过 8 选 8,同 VSCode autoFocusIndex)。
 */
export function indentSizePickItems(
  current: IndentOptions | undefined,
  configuredTabSize: number,
): { readonly items: readonly EncodingPickItem[]; readonly selectedIndex: number } {
  const cur = current?.tabSize;
  const items = INDENT_SIZES.map((n) => {
    const descriptionKey =
      n === configuredTabSize && n === cur
        ? 'encoding_picker.configured_tab_size'
        : n === configuredTabSize
          ? 'encoding_picker.default_tab_size'
          : n === cur
            ? 'encoding_picker.current_tab_size'
            : undefined;
    return { id: String(n), label: String(n), ...(descriptionKey ? { descriptionKey } : {}) };
  });
  return { items, selectedIndex: cur === undefined ? 0 : Math.max(0, Math.min(cur - 1, INDENT_SIZES.length - 1)) };
}

export const LINE_ENDINGS: readonly LineEnding[] = ['LF', 'CRLF'];

/**
 * 列表项与初始选中行。current:tab 当前编码 / 行尾(选中它;utf8bom 的 tab 在「重新打开」里没有 utf8bom,选中其别名 utf8,
 * 同 VSCode aliasMatchIndex)。
 */
export function encodingPickItems(
  request: EncodingPickRequest,
  current: {
    readonly encoding?: TextEncodingId;
    readonly eol?: LineEnding;
    readonly indent?: IndentOptions;
    readonly configuredTabSize?: number;
  } = {},
): { readonly items: readonly EncodingPickItem[]; readonly selectedIndex: number } {
  if (request.kind === 'action') {
    return {
      items: [
        { id: 'reopen', labelKey: 'encoding_picker.reopen' },
        { id: 'save', labelKey: 'encoding_picker.save' },
      ],
      selectedIndex: 0,
    };
  }
  if (request.kind === 'indent') return { items: INDENTATION_PICK_ACTIONS, selectedIndex: 0 };
  if (request.kind === 'indent-size') return indentSizePickItems(current.indent, current.configuredTabSize ?? 4);
  if (request.kind === 'eol') {
    const items = LINE_ENDINGS.map((eol) => ({ id: eol, label: eol }));
    return { items, selectedIndex: current.eol === 'CRLF' ? 1 : 0 };
  }
  const ids = request.kind === 'save' ? TEXT_ENCODING_IDS : TEXT_ENCODING_IDS.filter(isDecodableEncoding);
  const items = ids.map((id) => ({ id, label: TEXT_ENCODINGS[id].labelLong, description: id }));
  let selectedIndex = current.encoding === undefined ? -1 : ids.indexOf(current.encoding);
  if (selectedIndex < 0 && current.encoding === 'utf8bom') selectedIndex = ids.indexOf('utf8');
  return { items, selectedIndex: Math.max(0, selectedIndex) };
}
